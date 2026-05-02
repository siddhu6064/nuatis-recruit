import { Router, type IRouter, type Request, type Response } from "express";
import { db, jobsTable, clientsTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";
import { withAudit } from "@workspace/audit";
import { applicationsTable } from "@workspace/db";
import { generateJobSlug } from "../lib/slug";
import { inngest } from "../lib/inngest";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// POST /api/jobs
router.post("/jobs", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const {
    clientId,
    title,
    description,
    salaryMin,
    salaryMax,
    location,
    employmentType,
  } = req.body as Record<string, string | number>;

  if (!title || !clientId) {
    res.status(400).json({ error: "title and clientId are required" });
    return;
  }

  const [client] = await txDb
    .select()
    .from(clientsTable)
    .where(
      and(
        eq(clientsTable.id, String(clientId)),
        eq(clientsTable.workspaceId, user.workspaceId),
      ),
    );
  if (!client) {
    res.status(400).json({ error: "Client not found or not in your workspace" });
    return;
  }

  const slug = await generateJobSlug(txDb, user.workspaceId, String(title));

  const [job] = await withAudit(
    txDb,
    {
      workspaceId: user.workspaceId,
      action: "job.create",
      targetType: "job",
      userId: user.id,
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    },
    () =>
      txDb
        .insert(jobsTable)
        .values({
          workspaceId: user.workspaceId,
          clientId: String(clientId),
          title: String(title),
          description: description ? String(description) : null,
          salaryMin: salaryMin != null ? Number(salaryMin) : null,
          salaryMax: salaryMax != null ? Number(salaryMax) : null,
          location: location ? String(location) : null,
          employmentType: employmentType ? String(employmentType) : null,
          status: "draft",
          slug,
        })
        .returning(),
  );

  // Send response immediately; await Inngest after response is flushed
  res.status(201).json({ ...job, createdAt: job.createdAt?.toISOString() ?? null });

  // Await Inngest event AFTER commit + response (response already sent above)
  await inngest
    .send({
      name: "job.created",
      data: {
        jobId: job.id,
        workspaceId: user.workspaceId,
        description: String(description ?? ""),
      },
    })
    .catch((e: unknown) =>
      logger.warn({ err: e, jobId: job.id }, "Inngest job.created send failed"),
    );
});

// GET /api/jobs
router.get("/jobs", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const conditions = [eq(jobsTable.workspaceId, user.workspaceId)];
  if (req.query.client_id) conditions.push(eq(jobsTable.clientId, String(req.query.client_id)));
  if (req.query.status) conditions.push(eq(jobsTable.status, String(req.query.status)));

  const jobs = await txDb
    .select({
      id: jobsTable.id,
      title: jobsTable.title,
      status: jobsTable.status,
      location: jobsTable.location,
      slug: jobsTable.slug,
      clientId: jobsTable.clientId,
      createdAt: jobsTable.createdAt,
    })
    .from(jobsTable)
    .where(and(...conditions));

  // Applicant counts
  const counts = await txDb
    .select({ jobId: applicationsTable.jobId, count: count() })
    .from(applicationsTable)
    .where(eq(applicationsTable.workspaceId, user.workspaceId))
    .groupBy(applicationsTable.jobId);

  const countMap = new Map(counts.map((r) => [r.jobId, Number(r.count)]));

  // Client names
  const clientIds = [...new Set(jobs.map((j) => j.clientId))];
  const clientRows = clientIds.length
    ? await txDb
        .select({ id: clientsTable.id, name: clientsTable.name })
        .from(clientsTable)
        .where(eq(clientsTable.workspaceId, user.workspaceId))
    : [];
  const clientMap = new Map(clientRows.map((c) => [c.id, c.name]));

  res.json({
    jobs: jobs.map((j) => ({
      ...j,
      createdAt: j.createdAt?.toISOString() ?? null,
      applicantCount: countMap.get(j.id) ?? 0,
      clientName: clientMap.get(j.clientId) ?? null,
    })),
  });
});

// GET /api/jobs/:id
router.get("/jobs/:id", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const [job] = await txDb
    .select()
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.id, String(req.params.id)),
        eq(jobsTable.workspaceId, user.workspaceId),
      ),
    );

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json({ ...job, createdAt: job.createdAt?.toISOString() ?? null });
});

// PATCH /api/jobs/:id
router.patch("/jobs/:id", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;
  const jobId = String(req.params.id);

  const [existing] = await txDb
    .select()
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.id, jobId),
        eq(jobsTable.workspaceId, user.workspaceId),
      ),
    );

  if (!existing) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const { title, description, salaryMin, salaryMax, location, employmentType, status } = req.body as Record<string, string | number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = {};
  if (title !== undefined) patch.title = String(title);
  if (description !== undefined) patch.description = String(description);
  if (salaryMin !== undefined) patch.salaryMin = Number(salaryMin);
  if (salaryMax !== undefined) patch.salaryMax = Number(salaryMax);
  if (location !== undefined) patch.location = String(location);
  if (employmentType !== undefined) patch.employmentType = String(employmentType);
  if (status !== undefined) patch.status = String(status);

  const [updated] = await withAudit(
    txDb,
    {
      workspaceId: user.workspaceId,
      action: "job.update",
      targetType: "job",
      targetId: jobId,
      userId: user.id,
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    },
    () =>
      txDb
        .update(jobsTable)
        .set(patch)
        .where(eq(jobsTable.id, jobId))
        .returning(),
  );

  res.json({ ...updated, createdAt: updated.createdAt?.toISOString() ?? null });
});

// POST /api/jobs/:id/publish
router.post("/jobs/:id/publish", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;
  const jobId = String(req.params.id);

  const [existing] = await txDb
    .select()
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.id, jobId),
        eq(jobsTable.workspaceId, user.workspaceId),
      ),
    );

  if (!existing) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const [published] = await withAudit(
    txDb,
    {
      workspaceId: user.workspaceId,
      action: "job.publish",
      targetType: "job",
      targetId: jobId,
      userId: user.id,
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    },
    () =>
      txDb
        .update(jobsTable)
        .set({ status: "open" })
        .where(eq(jobsTable.id, jobId))
        .returning(),
  );

  res.json({ ...published, createdAt: published.createdAt?.toISOString() ?? null });
});

export default router;
