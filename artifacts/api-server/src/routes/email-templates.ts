/**
 * Email-template CRUD + server-side merge-field render.
 *
 * GET    /api/email-templates                 — list active templates (all roles)
 * POST   /api/email-templates                 — create template (owner only)
 * PATCH  /api/email-templates/:id             — update template (owner only)
 * DELETE /api/email-templates/:id             — archive template (owner only, soft delete)
 * POST   /api/email-templates/:id/render      — resolve merge fields server-side (all roles)
 *
 * Query params for GET:
 *   ?category=outreach   — filter by category
 *   ?archived=true       — include archived templates only
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  emailTemplatesTable,
  candidatesTable,
  jobsTable,
  clientsTable,
} from "@workspace/db";
import { requireAuth } from "@workspace/auth";
import { withAudit } from "@workspace/audit";
import { interpolate, getMissingTokens } from "../lib/email/merge-fields";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const VALID_CATEGORIES = new Set([
  "outreach",
  "screening",
  "interview",
  "offer",
  "rejection",
  "follow_up",
  "other",
]);

function requireOwner(req: Request, res: Response): boolean {
  if (req.user!.role !== "owner") {
    res.status(403).json({ error: "Owner role required" });
    return false;
  }
  return true;
}

// ─── GET /api/email-templates ─────────────────────────────────────
router.get("/email-templates", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const showArchived = req.query.archived === "true";
  const categoryFilter = req.query.category ? String(req.query.category) : null;

  const conditions = [eq(emailTemplatesTable.workspaceId, user.workspaceId)];
  if (!showArchived) {
    conditions.push(eq(emailTemplatesTable.isArchived, false));
  }
  if (categoryFilter) {
    conditions.push(eq(emailTemplatesTable.category, categoryFilter));
  }

  const templates = await txDb
    .select()
    .from(emailTemplatesTable)
    .where(and(...conditions))
    .orderBy(emailTemplatesTable.updatedAt);

  res.json({
    templates: templates.map((t) => ({
      ...t,
      createdAt: t.createdAt?.toISOString() ?? null,
      updatedAt: t.updatedAt?.toISOString() ?? null,
    })),
  });
});

// ─── POST /api/email-templates ────────────────────────────────────
router.post("/email-templates", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  if (!requireOwner(req, res)) return;
  const txDb = req.db ?? db;

  const { name, subject, body, category } = req.body as {
    name?: string;
    subject?: string;
    body?: string;
    category?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!subject?.trim()) {
    res.status(400).json({ error: "subject is required" });
    return;
  }
  if (!body?.trim()) {
    res.status(400).json({ error: "body is required" });
    return;
  }
  const cat = category ?? "other";
  if (!VALID_CATEGORIES.has(cat)) {
    res.status(400).json({ error: `category must be one of: ${[...VALID_CATEGORIES].join(", ")}` });
    return;
  }

  const [template] = await withAudit(
    txDb,
    {
      workspaceId: user.workspaceId,
      action: "template.created",
      targetType: "email_template",
      userId: user.id,
    },
    async () =>
      txDb
        .insert(emailTemplatesTable)
        .values({
          workspaceId: user.workspaceId,
          name: name.trim(),
          subject: subject.trim(),
          body: body.trim(),
          category: cat,
          createdBy: user.id,
        })
        .returning(),
  );

  logger.info({ userId: user.id, templateId: template.id }, "Email template created");
  res.status(201).json({
    ...template,
    createdAt: template.createdAt?.toISOString() ?? null,
    updatedAt: template.updatedAt?.toISOString() ?? null,
  });
});

// ─── PATCH /api/email-templates/:id ──────────────────────────────
router.patch("/email-templates/:id", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  if (!requireOwner(req, res)) return;
  const txDb = req.db ?? db;
  const { id } = req.params as { id: string };

  const [existing] = await txDb
    .select({ id: emailTemplatesTable.id })
    .from(emailTemplatesTable)
    .where(
      and(
        eq(emailTemplatesTable.id, id),
        eq(emailTemplatesTable.workspaceId, user.workspaceId),
      ),
    )
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const { name, subject, body, category } = req.body as {
    name?: string;
    subject?: string;
    body?: string;
    category?: string;
  };

  if (category !== undefined && !VALID_CATEGORIES.has(category)) {
    res.status(400).json({ error: `category must be one of: ${[...VALID_CATEGORIES].join(", ")}` });
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name.trim();
  if (subject !== undefined) updates.subject = subject.trim();
  if (body !== undefined) updates.body = body.trim();
  if (category !== undefined) updates.category = category;

  const [updated] = await withAudit(
    txDb,
    {
      workspaceId: user.workspaceId,
      action: "template.updated",
      targetType: "email_template",
      targetId: id,
      userId: user.id,
    },
    () =>
      txDb
        .update(emailTemplatesTable)
        .set(updates)
        .where(eq(emailTemplatesTable.id, id))
        .returning(),
  );

  res.json({
    ...updated,
    createdAt: updated.createdAt?.toISOString() ?? null,
    updatedAt: updated.updatedAt?.toISOString() ?? null,
  });
});

// ─── DELETE /api/email-templates/:id (soft delete) ───────────────
router.delete("/email-templates/:id", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  if (!requireOwner(req, res)) return;
  const txDb = req.db ?? db;
  const { id } = req.params as { id: string };

  const [existing] = await txDb
    .select({ id: emailTemplatesTable.id })
    .from(emailTemplatesTable)
    .where(
      and(
        eq(emailTemplatesTable.id, id),
        eq(emailTemplatesTable.workspaceId, user.workspaceId),
      ),
    )
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  await withAudit(
    txDb,
    {
      workspaceId: user.workspaceId,
      action: "template.archived",
      targetType: "email_template",
      targetId: id,
      userId: user.id,
    },
    () =>
      txDb
        .update(emailTemplatesTable)
        .set({ isArchived: true, updatedAt: new Date() })
        .where(eq(emailTemplatesTable.id, id)),
  );

  logger.info({ userId: user.id, templateId: id }, "Email template archived");
  res.json({ ok: true });
});

// ─── POST /api/email-templates/:id/render ────────────────────────
router.post(
  "/email-templates/:id/render",
  async (req: Request, res: Response) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const txDb = req.db ?? db;
    const { id } = req.params as { id: string };
    const { candidateId, jobId } = req.body as {
      candidateId?: string;
      jobId?: string;
    };

    if (!candidateId) {
      res.status(400).json({ error: "candidateId is required" });
      return;
    }

    const [template] = await txDb
      .select()
      .from(emailTemplatesTable)
      .where(
        and(
          eq(emailTemplatesTable.id, id),
          eq(emailTemplatesTable.workspaceId, user.workspaceId),
          eq(emailTemplatesTable.isArchived, false),
        ),
      )
      .limit(1);

    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    const [candidate] = await txDb
      .select({
        id: candidatesTable.id,
        name: candidatesTable.name,
        emails: candidatesTable.emails,
        currentTitle: candidatesTable.currentTitle,
        currentCompany: candidatesTable.currentCompany,
        location: candidatesTable.location,
      })
      .from(candidatesTable)
      .where(
        and(
          eq(candidatesTable.id, candidateId),
          eq(candidatesTable.workspaceId, user.workspaceId),
        ),
      )
      .limit(1);

    if (!candidate) {
      res.status(404).json({ error: "Candidate not found" });
      return;
    }

    let jobCtx:
      | {
          title?: string;
          location?: string;
          salaryMin?: number | null;
          salaryMax?: number | null;
        }
      | undefined;
    let clientCtx: { name?: string } | undefined;

    if (jobId) {
      const [job] = await txDb
        .select({
          id: jobsTable.id,
          title: jobsTable.title,
          location: jobsTable.location,
          salaryMin: jobsTable.salaryMin,
          salaryMax: jobsTable.salaryMax,
          clientId: jobsTable.clientId,
        })
        .from(jobsTable)
        .where(
          and(
            eq(jobsTable.id, jobId),
            eq(jobsTable.workspaceId, user.workspaceId),
          ),
        )
        .limit(1);

      if (job) {
        jobCtx = {
          title: job.title ?? undefined,
          location: job.location ?? undefined,
          salaryMin: job.salaryMin,
          salaryMax: job.salaryMax,
        };
        if (job.clientId) {
          const [client] = await txDb
            .select({ name: clientsTable.name })
            .from(clientsTable)
            .where(
              and(
                eq(clientsTable.id, job.clientId),
                eq(clientsTable.workspaceId, user.workspaceId),
              ),
            )
            .limit(1);
          if (client) clientCtx = { name: client.name ?? undefined };
        }
      }
    }

    const recruiterName =
      [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || undefined;

    const ctx = {
      candidate: {
        name: candidate.name ?? undefined,
        email: (candidate.emails as string[] | null)?.[0] ?? undefined,
        currentTitle: candidate.currentTitle ?? undefined,
        currentCompany: candidate.currentCompany ?? undefined,
        location: candidate.location ?? undefined,
      },
      job: jobCtx,
      client: clientCtx,
      recruiter: {
        name: recruiterName,
        email: user.email ?? undefined,
      },
    };

    const subject = interpolate(template.subject, ctx);
    const body = interpolate(template.body, ctx);
    const missingTokens = [
      ...new Set([
        ...getMissingTokens(template.subject, ctx),
        ...getMissingTokens(template.body, ctx),
      ]),
    ];

    res.json({ subject, body, missingTokens });
  },
);

export default router;
