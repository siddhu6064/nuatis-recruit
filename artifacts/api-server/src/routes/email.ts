/**
 * POST /api/email/send-system
 *
 * Internal-only route for server-side triggered transactional emails.
 * Protected by X-Internal-Token header matching INTERNAL_API_SECRET env var.
 * External clients (browsers, Postman) are rejected with 403.
 *
 * Used by internal tooling and tests; production sends go through the Inngest
 * email.mention function which calls the email service directly.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, emailMessagesTable, emailThreadsTable, auditLogsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";
import { sendTransactional } from "../lib/email/postmark";
import { renderMentionEmail } from "../lib/email/templates/mention";
import { sendReplyFn } from "../lib/email/send-reply";
import { composeEmailFn, validateComposeParams } from "../lib/email/compose-email";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function checkInternalAuth(req: Request, res: Response): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    res.status(503).json({
      error:
        "INTERNAL_API_SECRET is not configured — internal email route is unavailable.",
    });
    return false;
  }
  if (req.headers["x-internal-token"] !== secret) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

router.post("/email/send-system", async (req: Request, res: Response) => {
  if (!checkInternalAuth(req, res)) return;

  const { recipientUserId, type, payload } = req.body as {
    recipientUserId?: string;
    type?: string;
    payload?: Record<string, unknown>;
  };

  if (!recipientUserId || !type || !payload) {
    res.status(400).json({ error: "recipientUserId, type, and payload are required" });
    return;
  }

  if (type !== "note.mention") {
    res.status(400).json({ error: `Unsupported email type: ${type}` });
    return;
  }

  try {
    const {
      recipientEmail,
      recipientName,
      mentionerName,
      candidateName,
      candidateId,
      noteId,
      snippet,
      workspaceId,
    } = payload as {
      recipientEmail: string;
      recipientName: string;
      mentionerName: string;
      candidateName: string;
      candidateId: string;
      noteId: string;
      snippet: string;
      workspaceId: string;
    };

    const appBaseUrl =
      process.env.APP_BASE_URL ??
      `https://${(process.env.REPLIT_DOMAINS ?? "localhost").split(",")[0]}`;

    const template = renderMentionEmail({
      mentionerName,
      candidateName,
      candidateId,
      noteId,
      snippet,
      appBaseUrl,
    });

    const result = await sendTransactional({
      to: recipientEmail,
      subject: template.subject,
      html: template.html,
      text: template.text,
      tag: "system-mention",
      metadata: { workspaceId, noteId, candidateId, recipientUserId },
    });

    const [msgRow] = await db
      .insert(emailMessagesTable)
      .values({
        workspaceId,
        threadId: null,
        direction: "outbound",
        fromAddress: process.env.POSTMARK_FROM_ADDRESS ?? "",
        toAddresses: [recipientEmail],
        subject: template.subject,
        bodyText: template.text,
        bodyHtml: template.html,
        sentAt: result.submittedAt,
        status: "sent",
        postmarkMessageId: result.postmarkMessageId,
      })
      .returning({ id: emailMessagesTable.id });

    await db.insert(auditLogsTable).values({
      workspaceId,
      action: "email.sent",
      targetType: "email_message",
      targetId: msgRow.id,
      diffJson: { type, recipientUserId, postmarkMessageId: result.postmarkMessageId },
    });

    logger.info(
      { postmarkMessageId: result.postmarkMessageId, recipientEmail, noteId },
      "System mention email sent",
    );

    res.json({
      ok: true,
      emailMessageId: msgRow.id,
      postmarkMessageId: result.postmarkMessageId,
    });
  } catch (err) {
    logger.error({ err }, "Failed to send system email");
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/candidates/:id/email/compose ────────────────────────────────

router.post("/candidates/:id/email/compose", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { id: candidateId } = req.params as { id: string };
  const { to, subject, body } = req.body as {
    to?: string;
    subject?: string;
    body?: string;
  };

  const validationErr = validateComposeParams({
    to: to ?? "",
    subject: subject ?? "",
    body: body ?? "",
  });
  if (validationErr) {
    res.status(400).json({ error: validationErr.message, field: validationErr.field });
    return;
  }

  try {
    const result = await composeEmailFn({
      candidateId,
      workspaceId: user.workspaceId,
      userId: user.id,
      to: to!.trim(),
      subject: subject!.trim(),
      body: body!.trim(),
    });

    if (!result.ok) {
      const statusCode =
        result.code === "candidate_not_found" ? 404
        : result.code === "grant_missing" ? 409
        : 500;

      res.status(statusCode).json({
        error: result.code,
        code: result.code,
        ...(result.code === "send_failed"
          ? {
              emailMessageId: result.emailMessageId,
              threadId: result.threadId,
              detail: result.bounceReason,
            }
          : {}),
      });
      return;
    }

    res.status(201).json({
      ok: true,
      emailMessageId: result.emailMessageId,
      threadId: result.threadId,
    });
  } catch (err) {
    logger.error({ err, candidateId }, "Compose route unhandled error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── POST /api/email/threads/:id/reply ─────────────────────────────────────

router.post("/email/threads/:id/reply", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { id: threadId } = req.params as { id: string };
  const { body } = req.body as { body?: string };

  if (!body?.trim()) {
    res.status(400).json({ error: "body is required" });
    return;
  }

  try {
    const result = await sendReplyFn({
      threadId,
      workspaceId: user.workspaceId,
      userId: user.id,
      body: body.trim(),
    });

    if (!result.ok) {
      const statusCode =
        result.code === "not_found" ? 404
        : result.code === "grant_missing" ? 409
        : result.code === "no_inbound_message" ? 422
        : 500;

      res.status(statusCode).json({
        error: result.code,
        code: result.code,
        ...(result.code === "send_failed"
          ? { emailMessageId: result.emailMessageId, detail: result.bounceReason }
          : {}),
      });
      return;
    }

    res.json({ ok: true, emailMessageId: result.emailMessageId });
  } catch (err) {
    logger.error({ err, threadId }, "Reply route unhandled error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── GET /api/candidates/:id/email-threads ─────────────────────────────────

router.get("/candidates/:id/email-threads", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { id: candidateId } = req.params as { id: string };
  const txDb = req.db ?? db;

  const threads = await txDb
    .select({
      id: emailThreadsTable.id,
      subject: emailThreadsTable.subject,
      lastMessageAt: emailThreadsTable.lastMessageAt,
      messageCount: emailThreadsTable.messageCount,
      nylasThreadId: emailThreadsTable.nylasThreadId,
      createdAt: emailThreadsTable.createdAt,
    })
    .from(emailThreadsTable)
    .where(eq(emailThreadsTable.candidateId, candidateId))
    .orderBy(desc(emailThreadsTable.lastMessageAt));

  res.json({
    threads: threads.map((t) => ({
      ...t,
      lastMessageAt: t.lastMessageAt?.toISOString() ?? null,
      createdAt: t.createdAt?.toISOString() ?? null,
    })),
  });
});

// ── GET /api/email/threads/:id/messages ───────────────────────────────────

router.get("/email/threads/:id/messages", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { id: threadId } = req.params as { id: string };
  const txDb = req.db ?? db;

  const messages = await txDb
    .select({
      id: emailMessagesTable.id,
      direction: emailMessagesTable.direction,
      fromAddress: emailMessagesTable.fromAddress,
      toAddresses: emailMessagesTable.toAddresses,
      ccAddresses: emailMessagesTable.ccAddresses,
      subject: emailMessagesTable.subject,
      bodyText: emailMessagesTable.bodyText,
      bodyHtml: emailMessagesTable.bodyHtml,
      sentAt: emailMessagesTable.sentAt,
      status: emailMessagesTable.status,
      nylasMessageId: emailMessagesTable.nylasMessageId,
    })
    .from(emailMessagesTable)
    .where(eq(emailMessagesTable.threadId, threadId))
    .orderBy(emailMessagesTable.sentAt);

  res.json({
    messages: messages.map((m) => ({
      ...m,
      sentAt: m.sentAt?.toISOString() ?? null,
    })),
  });
});

export default router;
