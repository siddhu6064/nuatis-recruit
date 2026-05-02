import { Router, type IRouter, type Request, type Response } from "express";
import { db, candidatesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";
import { withAudit } from "@workspace/audit";

const router: IRouter = Router();

// POST /api/candidates
router.post("/candidates", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const { name, emails, phones, location, currentTitle, currentCompany, summary, source } =
    req.body as Record<string, string | string[]>;

  if (!name || !String(name).trim()) {
    res.status(400).json({ error: "name is required" });
    return;
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

  const [candidate] = await txDb
    .select()
    .from(candidatesTable)
    .where(
      and(
        eq(candidatesTable.id, req.params.id),
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

  const [existing] = await txDb
    .select()
    .from(candidatesTable)
    .where(
      and(
        eq(candidatesTable.id, req.params.id),
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
      targetId: req.params.id,
      userId: user.id,
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    },
    () =>
      txDb
        .update(candidatesTable)
        .set(patch)
        .where(eq(candidatesTable.id, req.params.id))
        .returning(),
  );

  res.json({
    ...updated,
    createdAt: updated.createdAt?.toISOString() ?? null,
    lastActivityAt: updated.lastActivityAt?.toISOString() ?? null,
  });
});

export default router;
