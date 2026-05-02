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
import { db, emailMessagesTable, auditLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendTransactional } from "../lib/email/postmark";
import { renderMentionEmail } from "../lib/email/templates/mention";
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

export default router;
