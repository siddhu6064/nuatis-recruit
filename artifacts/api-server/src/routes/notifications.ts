/**
 * Notifications API
 *
 * GET  /api/notifications           — unread + recent (last 50)
 * POST /api/notifications/mark-read — mark one or all as read
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, notificationsTable } from "@workspace/db";
import { eq, and, isNull, desc } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";

const router: IRouter = Router();

// ── GET /api/notifications ────────────────────────────────────────────────

router.get("/notifications", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const notifications = await txDb
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.workspaceId, user.workspaceId),
        eq(notificationsTable.recipientId, user.id),
      ),
    )
    .orderBy(desc(notificationsTable.createdAt))
    .limit(50);

  const unreadCount = notifications.filter((n) => !n.readAt).length;

  res.json({
    notifications: notifications.map((n) => ({
      ...n,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt?.toISOString() ?? null,
    })),
    unreadCount,
  });
});

// ── POST /api/notifications/mark-read ────────────────────────────────────

router.post("/notifications/mark-read", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const { id, all } = req.body as { id?: string; all?: boolean };

  if (all) {
    await txDb
      .update(notificationsTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notificationsTable.workspaceId, user.workspaceId),
          eq(notificationsTable.recipientId, user.id),
          isNull(notificationsTable.readAt),
        ),
      );
    res.json({ ok: true, markedAll: true });
    return;
  }

  if (!id) {
    res.status(400).json({ error: "id or all=true is required" });
    return;
  }

  await txDb
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notificationsTable.id, id),
        eq(notificationsTable.recipientId, user.id),
        eq(notificationsTable.workspaceId, user.workspaceId),
      ),
    );

  res.json({ ok: true, id });
});

export default router;
