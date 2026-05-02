import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  candidatesTable,
  applicationsTable,
  resumesTable,
  activitiesTable,
  notesTable,
  tasksTable,
  pool,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";
import { withAudit } from "@workspace/audit";

// ── Phone normalization ───────────────────────────────────────────────────
function normalizePhone(p: string): string {
  return p.replace(/\D/g, "").slice(-10);
}

/**
 * Check for duplicate candidates by email or normalized phone.
 * Returns matched candidate stubs. Uses its own pool client + RLS context.
 */
async function findDuplicates(
  workspaceId: string,
  emails: string[],
  phones: string[],
  excludeId?: string,
): Promise<{ id: string; name: string; emails: string[] | null; currentTitle: string | null }[]> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    const foundIds = new Set<string>();
    const rows: { id: string; name: string; emails: string[] | null; currentTitle: string | null }[] = [];

    for (const email of emails) {
      const r = await c.query<{ id: string; name: string; emails: string[]; current_title: string | null }>(
        `SELECT id, name, emails, current_title FROM candidates
         WHERE workspace_id = $1
           AND lower($2) = ANY(SELECT lower(e) FROM unnest(emails) e)
           ${excludeId ? "AND id != $3" : ""}`,
        excludeId ? [workspaceId, email, excludeId] : [workspaceId, email],
      );
      for (const row of r.rows) {
        if (!foundIds.has(row.id)) {
          foundIds.add(row.id);
          rows.push({ id: row.id, name: row.name, emails: row.emails, currentTitle: row.current_title });
        }
      }
    }

    const normPhones = phones.map(normalizePhone).filter((p) => p.length >= 7);
    for (const np of normPhones) {
      const r = await c.query<{ id: string; name: string; emails: string[]; current_title: string | null }>(
        `SELECT id, name, emails, current_title FROM candidates
         WHERE workspace_id = $1
           AND EXISTS (
             SELECT 1 FROM unnest(phones) ph
             WHERE right(regexp_replace(ph, '[^0-9]', '', 'g'), 10) = $2
           )
           ${excludeId ? "AND id != $3" : ""}`,
        excludeId ? [workspaceId, np, excludeId] : [workspaceId, np],
      );
      for (const row of r.rows) {
        if (!foundIds.has(row.id)) {
          foundIds.add(row.id);
          rows.push({ id: row.id, name: row.name, emails: row.emails, currentTitle: row.current_title });
        }
      }
    }
    await c.query("COMMIT");
    return rows;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

const router: IRouter = Router();

// POST /api/candidates
router.post("/candidates", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const { name, emails, phones, location, currentTitle, currentCompany, summary, source, force } =
    req.body as Record<string, string | string[] | boolean>;

  if (!name || !String(name).trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const emailArr: string[] = Array.isArray(emails) ? emails : emails ? [String(emails)] : [];
  const phoneArr: string[] = Array.isArray(phones) ? phones : phones ? [String(phones)] : [];

  // Dedup check (skip when force=true — recruiter chose "Create anyway")
  if (!force) {
    const dupes = await findDuplicates(user.workspaceId, emailArr, phoneArr);
    if (dupes.length > 0) {
      res.status(409).json({ error: "Possible duplicate candidate detected", duplicates: dupes });
      return;
    }
  }

  const [candidate] = await withAudit(
    txDb,
    {
      workspaceId: user.workspaceId,
      action: "candidate.create",
      targetType: "candidate",
      userId: user.id,
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    },
    () =>
      txDb
        .insert(candidatesTable)
        .values({
          workspaceId: user.workspaceId,
          name: String(name).trim(),
          emails: Array.isArray(emails) ? emails : emails ? [String(emails)] : [],
          phones: Array.isArray(phones) ? phones : phones ? [String(phones)] : [],
          location: location ? String(location) : null,
          currentTitle: currentTitle ? String(currentTitle) : null,
          currentCompany: currentCompany ? String(currentCompany) : null,
          summary: summary ? String(summary) : null,
          source: source ? String(source) : null,
        })
        .returning(),
  );

  res.status(201).json({
    ...candidate,
    createdAt: candidate.createdAt?.toISOString() ?? null,
    lastActivityAt: candidate.lastActivityAt?.toISOString() ?? null,
  });
});

// GET /api/candidates
router.get("/candidates", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const candidates = await txDb
    .select({
      id: candidatesTable.id,
      name: candidatesTable.name,
      currentTitle: candidatesTable.currentTitle,
      source: candidatesTable.source,
      lastActivityAt: candidatesTable.lastActivityAt,
      createdAt: candidatesTable.createdAt,
    })
    .from(candidatesTable)
    .where(eq(candidatesTable.workspaceId, user.workspaceId));

  res.json({
    candidates: candidates.map((c) => ({
      ...c,
      createdAt: c.createdAt?.toISOString() ?? null,
      lastActivityAt: c.lastActivityAt?.toISOString() ?? null,
    })),
  });
});

// GET /api/candidates/:id
router.get("/candidates/:id", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;
  const candidateId = String(req.params.id);

  const [candidate] = await txDb
    .select()
    .from(candidatesTable)
    .where(
      and(
        eq(candidatesTable.id, candidateId),
        eq(candidatesTable.workspaceId, user.workspaceId),
      ),
    );

  if (!candidate) {
    res.status(404).json({ error: "Candidate not found" });
    return;
  }

  res.json({
    ...candidate,
    createdAt: candidate.createdAt?.toISOString() ?? null,
    lastActivityAt: candidate.lastActivityAt?.toISOString() ?? null,
  });
});

// PATCH /api/candidates/:id
router.patch("/candidates/:id", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;
  const candidateId = String(req.params.id);

  const [existing] = await txDb
    .select()
    .from(candidatesTable)
    .where(
      and(
        eq(candidatesTable.id, candidateId),
        eq(candidatesTable.workspaceId, user.workspaceId),
      ),
    );

  if (!existing) {
    res.status(404).json({ error: "Candidate not found" });
    return;
  }

  const { name, emails, phones, location, currentTitle, currentCompany, summary, source } =
    req.body as Record<string, string | string[]>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = {};
  if (name !== undefined) patch.name = String(name).trim() || existing.name;
  if (emails !== undefined) patch.emails = Array.isArray(emails) ? emails : [String(emails)];
  if (phones !== undefined) patch.phones = Array.isArray(phones) ? phones : [String(phones)];
  if (location !== undefined) patch.location = String(location);
  if (currentTitle !== undefined) patch.currentTitle = String(currentTitle);
  if (currentCompany !== undefined) patch.currentCompany = String(currentCompany);
  if (summary !== undefined) patch.summary = String(summary);
  if (source !== undefined) patch.source = String(source);

  const [updated] = await withAudit(
    txDb,
    {
      workspaceId: user.workspaceId,
      action: "candidate.update",
      targetType: "candidate",
      targetId: candidateId,
      userId: user.id,
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    },
    () =>
      txDb
        .update(candidatesTable)
        .set(patch)
        .where(eq(candidatesTable.id, candidateId))
        .returning(),
  );

  res.json({
    ...updated,
    createdAt: updated.createdAt?.toISOString() ?? null,
    lastActivityAt: updated.lastActivityAt?.toISOString() ?? null,
  });
});

// ── POST /api/candidates/:sourceId/merge-into/:targetId ───────────────────
/**
 * Merges source into target:
 * - Moves applications (skipping FK conflicts), resumes, activities, notes, tasks
 * - Target wins on all field conflicts
 * - Writes audit_logs candidate.merged + activity row
 * - Deletes source candidate
 */
router.post(
  "/candidates/:sourceId/merge-into/:targetId",
  async (req: Request, res: Response) => {
    const user = requireAuth(req, res);
    if (!user) return;

    const sourceId = String(req.params.sourceId);
    const targetId = String(req.params.targetId);

    if (sourceId === targetId) {
      res.status(400).json({ error: "source and target must be different" });
      return;
    }

    const c = await pool.connect();
    let committed = false;
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_workspace_id', $1, true)", [user.workspaceId]);
      await c.query("SELECT set_config('app.current_user_id', $1, true)", [user.id]);

      const sr = await c.query<{ id: string; name: string; emails: string[]; phones: string[]; current_title: string | null }>(
        `SELECT id, name, emails, phones, current_title FROM candidates
         WHERE id = $1 AND workspace_id = $2`,
        [sourceId, user.workspaceId],
      );
      const tr = await c.query<{ id: string }>(
        `SELECT id FROM candidates WHERE id = $1 AND workspace_id = $2`,
        [targetId, user.workspaceId],
      );

      if (!sr.rows[0]) { res.status(404).json({ error: "Source candidate not found" }); return; }
      if (!tr.rows[0]) { res.status(404).json({ error: "Target candidate not found" }); return; }
      const source = sr.rows[0];

      // Move applications — skip if candidate_id + job_id already exists on target
      await c.query(
        `UPDATE applications SET candidate_id = $1
         WHERE candidate_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM applications e WHERE e.candidate_id = $1 AND e.job_id = applications.job_id
           )`,
        [targetId, sourceId],
      );
      await c.query(`DELETE FROM applications WHERE candidate_id = $1`, [sourceId]);

      // Move remaining FK-linked rows
      await c.query(`UPDATE resumes    SET candidate_id = $1 WHERE candidate_id = $2`, [targetId, sourceId]);
      await c.query(`UPDATE activities SET candidate_id = $1 WHERE candidate_id = $2`, [targetId, sourceId]);
      await c.query(`UPDATE notes      SET candidate_id = $1 WHERE candidate_id = $2`, [targetId, sourceId]);
      await c.query(
        `UPDATE tasks SET candidate_id = $1 WHERE candidate_id = $2 AND candidate_id IS NOT NULL`,
        [targetId, sourceId],
      );

      // Audit
      await c.query(
        `INSERT INTO audit_logs (workspace_id, user_id, action, target_type, target_id, diff_json)
         VALUES ($1, $2, 'candidate.merged', 'candidate', $3, $4::jsonb)`,
        [user.workspaceId, user.id, targetId,
         JSON.stringify({ source_id: sourceId, source_name: source.name,
           source_emails: source.emails, resolution: "target_wins" })],
      );

      await c.query(
        `INSERT INTO activities (workspace_id, candidate_id, user_id, type, payload)
         VALUES ($1, $2, $3, 'candidate.merged', $4::jsonb)`,
        [user.workspaceId, targetId, user.id,
         JSON.stringify({ source_id: sourceId, source_name: source.name })],
      );

      await c.query(`DELETE FROM candidates WHERE id = $1`, [sourceId]);
      await c.query("COMMIT");
      committed = true;

      res.json({ ok: true, targetId, mergedFrom: sourceId });
    } catch (err) {
      if (!committed) await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  },
);

export default router;
