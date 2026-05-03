/**
 * GET  /api/email/accounts              — list connected email accounts for current user
 * POST /api/email/accounts/:id/disconnect — revoke Nylas grant + mark row revoked
 *
 * Role visibility:
 *   owner  → all accounts in the workspace
 *   others → only their own accounts
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, connectedEmailAccountsTable, auditLogsTable } from "@workspace/db";
import { and, eq, or } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";
import { revokeGrant } from "../lib/email/nylas";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// GET /api/email/accounts
router.get("/email/accounts", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const isOwner = user.role === "owner";

  const accounts = await txDb
    .select({
      id: connectedEmailAccountsTable.id,
      provider: connectedEmailAccountsTable.provider,
      emailAddress: connectedEmailAccountsTable.emailAddress,
      status: connectedEmailAccountsTable.status,
      connectedAt: connectedEmailAccountsTable.connectedAt,
      lastSyncAt: connectedEmailAccountsTable.lastSyncAt,
      userId: connectedEmailAccountsTable.userId,
    })
    .from(connectedEmailAccountsTable)
    .where(
      isOwner
        ? eq(connectedEmailAccountsTable.workspaceId, user.workspaceId)
        : and(
            eq(connectedEmailAccountsTable.workspaceId, user.workspaceId),
            eq(connectedEmailAccountsTable.userId, user.id),
          ),
    )
    .orderBy(connectedEmailAccountsTable.connectedAt);

  res.json({
    accounts: accounts.map((a) => ({
      ...a,
      connectedAt: a.connectedAt?.toISOString() ?? null,
      lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
    })),
  });
});

// POST /api/email/accounts/:id/disconnect
router.post(
  "/email/accounts/:id/disconnect",
  async (req: Request, res: Response) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const { id } = req.params as { id: string };
    const txDb = req.db ?? db;

    const [account] = await txDb
      .select()
      .from(connectedEmailAccountsTable)
      .where(
        and(
          eq(connectedEmailAccountsTable.id, id),
          eq(connectedEmailAccountsTable.workspaceId, user.workspaceId),
        ),
      )
      .limit(1);

    if (!account) {
      res.status(404).json({ error: "Account not found" });
      return;
    }

    // Only owner or account owner can disconnect
    if (user.role !== "owner" && account.userId !== user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Attempt Nylas revocation — non-fatal if it fails (grant may already be revoked)
    try {
      await revokeGrant(account.nylasGrantId);
    } catch (err) {
      logger.warn({ err, grantId: account.nylasGrantId }, "Nylas grant revocation failed — continuing with DB update");
    }

    await txDb
      .update(connectedEmailAccountsTable)
      .set({ status: "revoked" })
      .where(eq(connectedEmailAccountsTable.id, id));

    await txDb.insert(auditLogsTable).values({
      workspaceId: user.workspaceId,
      userId: user.id,
      action: "email_account.revoked",
      targetType: "connected_email_account",
      targetId: id,
      diffJson: { email: account.emailAddress, grantId: account.nylasGrantId },
    });

    logger.info({ userId: user.id, accountId: id, email: account.emailAddress }, "Email account disconnected");
    res.json({ ok: true });
  },
);

export default router;
