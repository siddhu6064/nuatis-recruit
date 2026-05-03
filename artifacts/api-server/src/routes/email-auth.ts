/**
 * GET /api/email/auth/start    — redirect user to Nylas Hosted Auth
 * GET /api/email/auth/callback — exchange code, store grant, redirect to /settings/email
 *
 * Flow:
 *   1. start: generate signed state token → redirect to Nylas OAuth URL
 *   2. callback: validate state + exchange code + upsert connected_email_accounts
 *
 * Both routes require the user to be authenticated (session cookie present).
 */
import { randomUUID } from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, connectedEmailAccountsTable, auditLogsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";
import { createAuthUrl, exchangeCode } from "../lib/email/nylas";
import { signState, verifyState, generateNonce } from "../lib/email/state-token";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function callbackUrl(req: Request): string {
  const appBaseUrl =
    process.env.APP_BASE_URL ??
    `https://${(process.env.REPLIT_DOMAINS ?? "localhost").split(",")[0]}`;
  return `${appBaseUrl}/api/email/auth/callback`;
}

/** Map Nylas provider string → our DB check constraint values */
function mapProvider(nylasProvider: string): "gmail" | "outlook" | "imap" {
  if (nylasProvider === "google") return "gmail";
  if (nylasProvider === "microsoft") return "outlook";
  return "imap";
}

// GET /api/email/auth/start
router.get("/email/auth/start", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const state = signState({
    userId: user.id,
    workspaceId: user.workspaceId,
    nonce: generateNonce(),
    exp: Math.floor(Date.now() / 1000) + 300, // 5 min
  });

  let url: string;
  try {
    url = createAuthUrl(state, callbackUrl(req));
  } catch (err) {
    logger.error({ err }, "Nylas createAuthUrl failed — check NYLAS_CLIENT_ID/SECRET");
    res.status(503).json({ error: "Email OAuth not configured. Contact your administrator." });
    return;
  }

  res.redirect(url);
});

// GET /api/email/auth/callback
router.get("/email/auth/callback", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { code, state: rawState, error: oauthError } = req.query as Record<string, string>;

  const settingsUrl =
    process.env.APP_BASE_URL
      ? `${process.env.APP_BASE_URL}/settings/email`
      : `https://${(process.env.REPLIT_DOMAINS ?? "localhost").split(",")[0]}/settings/email`;

  if (oauthError) {
    logger.warn({ oauthError, userId: user.id }, "Nylas OAuth returned error");
    res.redirect(`${settingsUrl}?error=${encodeURIComponent(oauthError)}`);
    return;
  }

  if (!code || !rawState) {
    res.status(400).json({ error: "Missing code or state parameter" });
    return;
  }

  let statePayload;
  try {
    statePayload = verifyState(rawState, user.workspaceId);
  } catch (err) {
    logger.warn({ err, userId: user.id }, "Nylas OAuth state token invalid");
    res.status(400).json({ error: "Invalid or expired OAuth state. Please try again." });
    return;
  }

  if (statePayload.userId !== user.id) {
    res.status(403).json({ error: "State token user mismatch" });
    return;
  }

  let grant;
  try {
    grant = await exchangeCode(code, callbackUrl(req));
  } catch (err) {
    logger.error({ err, userId: user.id }, "Nylas code exchange failed");
    res.redirect(`${settingsUrl}?error=code_exchange_failed`);
    return;
  }

  const provider = mapProvider(grant.provider);

  try {
    await db
      .insert(connectedEmailAccountsTable)
      .values({
        id: randomUUID() as `${string}-${string}-${string}-${string}-${string}`,
        workspaceId: user.workspaceId,
        userId: user.id,
        provider,
        emailAddress: grant.email,
        nylasGrantId: grant.grantId,
        status: "active",
        connectedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          connectedEmailAccountsTable.workspaceId,
          connectedEmailAccountsTable.userId,
          connectedEmailAccountsTable.emailAddress,
        ],
        set: {
          nylasGrantId: grant.grantId,
          provider,
          status: "active",
          connectedAt: new Date(),
        },
      });

    await db.insert(auditLogsTable).values({
      workspaceId: user.workspaceId,
      userId: user.id,
      action: "email_account.connected",
      targetType: "connected_email_account",
      diffJson: { email: grant.email, provider, grantId: grant.grantId },
    });

    logger.info({ userId: user.id, email: grant.email, provider }, "Email account connected");
    res.redirect(`${settingsUrl}?success=connected`);
  } catch (err) {
    logger.error({ err, userId: user.id }, "Failed to save connected email account");
    res.redirect(`${settingsUrl}?error=save_failed`);
  }
});

export default router;
