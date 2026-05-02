import { Router, type IRouter, type Request, type Response } from "express";
import { db, applicationsTable, candidatesTable, jobsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";

const router: IRouter = Router();

// GET /api/applications?job_id=&candidate_id=
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
      source: applicationsTable.source,
      appliedAt: applicationsTable.appliedAt,
      lastActivityAt: applicationsTable.lastActivityAt,
      candidateName: candidatesTable.name,
      jobTitle: jobsTable.title,
    })
    .from(applicationsTable)
    .leftJoin(candidatesTable, eq(applicationsTable.candidateId, candidatesTable.id))
    .leftJoin(jobsTable, eq(applicationsTable.jobId, jobsTable.id))
    .where(and(...conditions));

  res.json({
    applications: apps.map((a) => ({
      ...a,
      appliedAt: a.appliedAt?.toISOString() ?? null,
      lastActivityAt: a.lastActivityAt?.toISOString() ?? null,
    })),
  });
});

export default router;
