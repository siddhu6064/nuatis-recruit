/**
 * Saved searches (segments)
 *
 * GET  /api/saved-searches        — list all for workspace
 * POST /api/saved-searches        — create / save current search
 * DELETE /api/saved-searches/:id  — delete
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, savedSearchesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";

const router: IRouter = Router();

router.get("/saved-searches", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const searches = await txDb
    .select()
    .from(savedSearchesTable)
    .where(eq(savedSearchesTable.workspaceId, user.workspaceId));

  res.json({
    savedSearches: searches.map((s) => ({
      ...s,
      createdAt: s.createdAt?.toISOString() ?? null,
    })),
  });
});

router.post("/saved-searches", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const { name, queryJson } = req.body as { name?: string; queryJson?: Record<string, unknown> };
  if (!name?.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const [search] = await txDb
    .insert(savedSearchesTable)
    .values({
      workspaceId: user.workspaceId,
      ownerId: user.id,
      name: name.trim(),
      queryJson: queryJson ?? {},
    })
    .returning();

  res.status(201).json({ ...search, createdAt: search.createdAt?.toISOString() ?? null });
});

router.delete("/saved-searches/:id", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;
  const id = String(req.params.id);

  const [existing] = await txDb
    .select({ id: savedSearchesTable.id })
    .from(savedSearchesTable)
    .where(and(eq(savedSearchesTable.id, id), eq(savedSearchesTable.workspaceId, user.workspaceId)));

  if (!existing) {
    res.status(404).json({ error: "Saved search not found" });
    return;
  }

  await txDb.delete(savedSearchesTable).where(eq(savedSearchesTable.id, id));
  res.json({ ok: true });
});

export default router;
