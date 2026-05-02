import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { rejectionReasonsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";

const router: IRouter = Router();

// GET /api/rejection-reasons
router.get("/rejection-reasons", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const reasons = await txDb
    .select()
    .from(rejectionReasonsTable)
    .where(eq(rejectionReasonsTable.workspaceId, user.workspaceId))
    .orderBy(asc(rejectionReasonsTable.sortOrder));

  res.json({ rejectionReasons: reasons });
});

export default router;
