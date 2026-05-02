/**
 * GET /api/match-scores?application_id=&job_id=
 *
 * Returns match score rows for the current workspace.
 * Supports polling by the UI (3-second interval until score appears).
 *
 * Uses raw SQL (pool.query) to avoid cross-package drizzle-orm type conflicts
 * caused by the @opentelemetry/api peer dep split between @workspace/db and
 * the api-server's inngest dependency.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "@workspace/auth";

const router: IRouter = Router();

router.get("/match-scores", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const { application_id, job_id } = req.query as Record<string, string | undefined>;

  if (application_id) {
    const result = await pool.query(
      `SELECT id, workspace_id, application_id, score, breakdown, rationale, evidence_quotes, model_version, created_at
       FROM match_scores
       WHERE workspace_id = $1 AND application_id = $2
       LIMIT 1`,
      [user.workspaceId, application_id],
    );
    const score = result.rows[0] ?? null;
    res.json({ matchScore: score ? { ...score, createdAt: score.created_at?.toISOString() ?? null } : null });
    return;
  }

  if (job_id) {
    // Fetch all application IDs for this job in this workspace
    const appsResult = await pool.query<{ id: string }>(
      `SELECT id FROM applications WHERE workspace_id = $1 AND job_id = $2`,
      [user.workspaceId, job_id],
    );

    if (appsResult.rows.length === 0) {
      res.json({ matchScores: [] });
      return;
    }

    const appIds = appsResult.rows.map((r) => r.id);
    const placeholders = appIds.map((_, i) => `$${i + 2}`).join(", ");

    const scoresResult = await pool.query(
      `SELECT id, workspace_id, application_id, score, breakdown, rationale, evidence_quotes, model_version, created_at
       FROM match_scores
       WHERE workspace_id = $1 AND application_id IN (${placeholders})`,
      [user.workspaceId, ...appIds],
    );

    res.json({
      matchScores: scoresResult.rows.map((s) => ({
        ...s,
        createdAt: s.created_at?.toISOString() ?? null,
      })),
    });
    return;
  }

  res.status(400).json({ error: "application_id or job_id query param required" });
});

export default router;
