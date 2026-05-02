import { Router, type IRouter, type Request, type Response } from "express";
import { db, applicationsTable, candidatesTable, jobsTable, activitiesTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";
import { withAudit } from "@workspace/audit";
import { logger } from "../lib/logger";
import { inngest } from "../lib/inngest";

const router: IRouter = Router();

// ─── Position helpers ─────────────────────────────────────────────────────

/**
 * Compute the next position for a new card at the end of a stage.
 * Returns (maxPosition + 1000) or 1000 if stage is empty.
 */
async function getNextPosition(
  txDb: typeof db,
  workspaceId: string,
  jobId: string,
  stage: string,
): Promise<number> {
  const rows = await txDb
    .select({ pos: applicationsTable.positionInStage })
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.workspaceId, workspaceId),
        eq(applicationsTable.jobId, jobId),
        eq(applicationsTable.stage, stage),
      ),
    );
  if (rows.length === 0) return 1000;
  return Math.max(...rows.map((r) => r.pos)) + 1000;
}

/**
 * Rebalance positions within a stage when any consecutive gap < 100.
 * Reassigns positions as multiples of 1000 ordered by current position.
 * All writes go through the same txDb (stays in transaction).
 */
async function maybeRebalance(
  txDb: typeof db,
  workspaceId: string,
  jobId: string,
  stage: string,
): Promise<void> {
  const rows = await txDb
    .select({ id: applicationsTable.id, pos: applicationsTable.positionInStage })
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.workspaceId, workspaceId),
        eq(applicationsTable.jobId, jobId),
        eq(applicationsTable.stage, stage),
      ),
    )
    .orderBy(applicationsTable.positionInStage);

  if (rows.length < 2) return;

  // Check if any gap < 100
  let needsRebalance = false;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].pos - rows[i - 1].pos < 100) {
      needsRebalance = true;
      break;
    }
  }
  if (!needsRebalance) return;

  logger.info({ jobId, stage, count: rows.length }, "Rebalancing stage positions");
  for (let i = 0; i < rows.length; i++) {
    await txDb
      .update(applicationsTable)
      .set({ positionInStage: (i + 1) * 1000 })
      .where(eq(applicationsTable.id, rows[i].id));
  }
}

// ─── GET /api/applications ────────────────────────────────────────────────

router.get("/applications", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const conditions = [eq(applicationsTable.workspaceId, user.workspaceId)];
  if (req.query.job_id) conditions.push(eq(applicationsTable.jobId, String(req.query.job_id)));
  if (req.query.candidate_id) conditions.push(eq(applicationsTable.candidateId, String(req.query.candidate_id)));

  const apps = await txDb
    .select({
      id: applicationsTable.id,
      candidateId: applicationsTable.candidateId,
      jobId: applicationsTable.jobId,
      stage: applicationsTable.stage,
      positionInStage: applicationsTable.positionInStage,
      source: applicationsTable.source,
      appliedAt: applicationsTable.appliedAt,
      lastActivityAt: applicationsTable.lastActivityAt,
      candidateName: candidatesTable.name,
      candidateCurrentTitle: candidatesTable.currentTitle,
      jobTitle: jobsTable.title,
    })
    .from(applicationsTable)
    .leftJoin(candidatesTable, eq(applicationsTable.candidateId, candidatesTable.id))
    .leftJoin(jobsTable, eq(applicationsTable.jobId, jobsTable.id))
    .where(and(...conditions))
    .orderBy(applicationsTable.positionInStage);

  // Fetch most-recent stage_change activity per application for "days in stage"
  const appIds = apps.map((a) => a.id);
  let stageChangedMap = new Map<string, string>();
  if (appIds.length > 0) {
    // Raw query: DISTINCT ON to get latest stage_change per application_id from payload
    const raw = await (req.db ?? db).execute(
      drizzleSql`
        SELECT DISTINCT ON ((payload->>'application_id'))
          payload->>'application_id' AS application_id,
          created_at
        FROM activities
        WHERE workspace_id = ${user.workspaceId}
          AND type = 'application.stage_change'
          AND payload->>'application_id' = ANY(${appIds})
        ORDER BY (payload->>'application_id'), created_at DESC
      `,
    );
    for (const row of raw.rows as { application_id: string; created_at: Date }[]) {
      stageChangedMap.set(row.application_id, row.created_at.toISOString());
    }
  }

  res.json({
    applications: apps.map((a) => ({
      ...a,
      appliedAt: a.appliedAt?.toISOString() ?? null,
      lastActivityAt: a.lastActivityAt?.toISOString() ?? null,
      lastStageChangedAt: stageChangedMap.get(a.id) ?? null,
    })),
  });
});

// ─── POST /api/applications/:id/move ─────────────────────────────────────
// Stage transition — the single authoritative path for all stage moves.
// Writes: applications.stage + activities row + audit_log in one transaction.

router.post("/applications/:id/move", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;
  const appId = String(req.params.id);

  const { stage: newStage, positionInStage } = req.body as {
    stage: string;
    positionInStage?: number;
  };

  if (!newStage) {
    res.status(400).json({ error: "stage is required" });
    return;
  }

  // Fetch current application
  const [existing] = await txDb
    .select()
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.id, appId),
        eq(applicationsTable.workspaceId, user.workspaceId),
      ),
    );

  if (!existing) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  const fromStage = existing.stage;

  // Determine target position
  let targetPosition = positionInStage;
  if (targetPosition === undefined) {
    if (newStage !== fromStage) {
      // Moving to a new stage: place at the end
      targetPosition = await getNextPosition(txDb, user.workspaceId, existing.jobId, newStage);
    } else {
      // Same stage, no position specified: keep current
      targetPosition = existing.positionInStage;
    }
  }

  // All writes in the same transaction (req.db is the RLS transaction client)
  const [updated] = await withAudit(
    txDb,
    {
      workspaceId: user.workspaceId,
      action: "application.stage_change",
      targetType: "application",
      targetId: appId,
      userId: user.id,
      diff: { from_stage: fromStage, to_stage: newStage },
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    },
    () =>
      txDb
        .update(applicationsTable)
        .set({
          stage: newStage,
          positionInStage: targetPosition!,
          lastActivityAt: new Date(),
        })
        .where(eq(applicationsTable.id, appId))
        .returning(),
  );

  // Insert activity row (stage_change — candidateId required by activities schema)
  await txDb.insert(activitiesTable).values({
    workspaceId: user.workspaceId,
    candidateId: existing.candidateId,
    userId: user.id,
    type: "application.stage_change",
    payload: {
      from_stage: fromStage,
      to_stage: newStage,
      by_user_id: user.id,
      application_id: appId,
    },
  });

  // Rebalance positions if needed (still within same transaction)
  if (newStage !== fromStage || targetPosition !== existing.positionInStage) {
    await maybeRebalance(txDb, user.workspaceId, existing.jobId, newStage);
  }

  logger.info({ appId, fromStage, newStage, userId: user.id }, "Stage moved");

  // After transaction commits, check for stage automations
  res.json({
    id: updated.id,
    stage: updated.stage,
    positionInStage: updated.positionInStage,
  });

  // Fire stage.entered for matching automations (after response)
  setImmediate(async () => {
    try {
      const automations = await db
        .select({ id: (await import("@workspace/db")).stageAutomationsTable.id })
        .from((await import("@workspace/db")).stageAutomationsTable)
        .where(
          and(
            eq((await import("@workspace/db")).stageAutomationsTable.workspaceId, user.workspaceId),
            eq((await import("@workspace/db")).stageAutomationsTable.stageKey, newStage),
          ),
        );
      if (automations.length > 0) {
        await inngest.send({
          name: "stage.entered",
          data: {
            applicationId: appId,
            candidateId: existing.candidateId,
            jobId: existing.jobId,
            workspaceId: user.workspaceId,
            stageKey: newStage,
            automationIds: automations.map((a) => a.id),
          },
        });
        logger.info({ appId, newStage, count: automations.length }, "stage.entered fired");
      }
    } catch (err) {
      logger.warn({ err, appId, newStage }, "stage.entered dispatch failed");
    }
  });
});

// ─── POST /api/applications/bulk-move ────────────────────────────────────

router.post("/applications/bulk-move", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const { applicationIds, stage: newStage } = req.body as {
    applicationIds: string[];
    stage: string;
  };

  if (!Array.isArray(applicationIds) || applicationIds.length === 0) {
    res.status(400).json({ error: "applicationIds array is required" });
    return;
  }
  if (!newStage) {
    res.status(400).json({ error: "stage is required" });
    return;
  }

  // Verify all applications belong to this workspace, collect unique job IDs
  const existing = await txDb
    .select()
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.workspaceId, user.workspaceId),
        inArray(applicationsTable.id, applicationIds),
      ),
    );

  if (existing.length !== applicationIds.length) {
    res.status(400).json({ error: "One or more applications not found in your workspace" });
    return;
  }

  // Place each app at end of target stage (staggered by 1000)
  let basePosition = 1000;
  const currentMax = await txDb
    .select({ pos: applicationsTable.positionInStage })
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.workspaceId, user.workspaceId),
        eq(applicationsTable.stage, newStage),
      ),
    );
  if (currentMax.length > 0) {
    basePosition = Math.max(...currentMax.map((r) => r.pos)) + 1000;
  }

  const updated: string[] = [];
  for (let i = 0; i < existing.length; i++) {
    const app = existing[i];
    const fromStage = app.stage;
    const targetPos = basePosition + i * 1000;

    await withAudit(
      txDb,
      {
        workspaceId: user.workspaceId,
        action: "application.stage_change",
        targetType: "application",
        targetId: app.id,
        userId: user.id,
        diff: { from_stage: fromStage, to_stage: newStage, bulk: true },
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
      },
      () =>
        txDb
          .update(applicationsTable)
          .set({ stage: newStage, positionInStage: targetPos, lastActivityAt: new Date() })
          .where(eq(applicationsTable.id, app.id))
          .returning(),
    );

    await txDb.insert(activitiesTable).values({
      workspaceId: user.workspaceId,
      candidateId: app.candidateId,
      userId: user.id,
      type: "application.stage_change",
      payload: {
        from_stage: fromStage,
        to_stage: newStage,
        by_user_id: user.id,
        application_id: app.id,
        bulk: true,
      },
    });

    updated.push(app.id);
  }

  // Rebalance unique job / stage combos affected
  const jobIds = [...new Set(existing.map((a) => a.jobId))];
  for (const jobId of jobIds) {
    await maybeRebalance(txDb, user.workspaceId, jobId, newStage);
  }

  logger.info({ count: updated.length, newStage, userId: user.id }, "Bulk move complete");
  res.json({ moved: updated.length, stage: newStage });
});

// ─── POST /api/applications/bulk-reject ──────────────────────────────────

router.post("/applications/bulk-reject", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const { applicationIds, rejectionReasonId, sendTemplateEmail } = req.body as {
    applicationIds: string[];
    rejectionReasonId?: string;
    sendTemplateEmail?: boolean;
  };

  if (!Array.isArray(applicationIds) || applicationIds.length === 0) {
    res.status(400).json({ error: "applicationIds array is required" });
    return;
  }

  const existing = await txDb
    .select()
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.workspaceId, user.workspaceId),
        inArray(applicationsTable.id, applicationIds),
      ),
    );

  if (existing.length !== applicationIds.length) {
    res.status(400).json({ error: "One or more applications not found in your workspace" });
    return;
  }

  const rejected: string[] = [];
  for (const app of existing) {
    const fromStage = app.stage;

    await withAudit(
      txDb,
      {
        workspaceId: user.workspaceId,
        action: "application.reject",
        targetType: "application",
        targetId: app.id,
        userId: user.id,
        diff: {
          from_stage: fromStage,
          to_stage: "rejected",
          rejection_reason_id: rejectionReasonId ?? null,
          send_template_email: sendTemplateEmail ?? false,
        },
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
      },
      () =>
        txDb
          .update(applicationsTable)
          .set({ stage: "rejected", lastActivityAt: new Date() })
          .where(eq(applicationsTable.id, app.id))
          .returning(),
    );

    await txDb.insert(activitiesTable).values({
      workspaceId: user.workspaceId,
      candidateId: app.candidateId,
      userId: user.id,
      type: "application.stage_change",
      payload: {
        from_stage: fromStage,
        to_stage: "rejected",
        by_user_id: user.id,
        application_id: app.id,
        rejection_reason_id: rejectionReasonId ?? null,
        send_template_email: sendTemplateEmail ?? false,
        // Email sending is a stub — Phase 4 will wire actual delivery
        email_stub: sendTemplateEmail ? "STUB: email would be sent" : null,
      },
    });

    rejected.push(app.id);
  }

  logger.info({ count: rejected.length, userId: user.id }, "Bulk reject complete");
  res.json({ rejected: rejected.length });
});

export default router;
