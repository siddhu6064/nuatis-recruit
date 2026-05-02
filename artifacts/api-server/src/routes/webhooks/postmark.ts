/**
 * POST /api/webhooks/postmark
 *
 * Receives bounce and complaint events from Postmark.
 * Authenticated via HTTP Basic auth (POSTMARK_WEBHOOK_USERNAME + POSTMARK_WEBHOOK_PASSWORD).
 *
 * Handled record types:
 *   Bounce / HardBounce  → status='bounced', bounce_reason set, audit_log written
 *   SpamComplaint        → status='bounced', bounce_reason='SpamComplaint', audit_log written
 *
 * Other record types are accepted with 200 and ignored.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, emailMessagesTable, auditLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

function checkBasicAuth(req: Request, res: Response): boolean {
  const username = process.env.POSTMARK_WEBHOOK_USERNAME;
  const password = process.env.POSTMARK_WEBHOOK_PASSWORD;

  if (!username || !password) {
    logger.warn("POSTMARK_WEBHOOK_USERNAME or POSTMARK_WEBHOOK_PASSWORD not set — webhook rejected");
    res.status(401).json({ error: "Webhook credentials not configured" });
    return false;
  }

  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Basic ")) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }

  const encoded = authHeader.slice(6);
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }

  const colonIdx = decoded.indexOf(":");
  const reqUser = colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded;
  const reqPass = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : "";

  if (reqUser !== username || reqPass !== password) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }

  return true;
}

router.post("/webhooks/postmark", async (req: Request, res: Response) => {
  if (!checkBasicAuth(req, res)) return;

  const body = req.body as {
    RecordType?: string;
    Type?: string;
    MessageID?: string;
    Description?: string;
    Details?: string;
  };

  const { RecordType, Type, MessageID, Description, Details } = body;

  logger.info({ RecordType, Type, MessageID }, "Postmark webhook received");

  const isBounce =
    RecordType === "Bounce" && (Type === "HardBounce" || Type === "SoftBounce");
  const isHardBounce = RecordType === "Bounce" && Type === "HardBounce";
  const isSpamComplaint = RecordType === "SpamComplaint";

  if (!isHardBounce && !isSpamComplaint) {
    res.json({ ok: true, handled: false, recordType: RecordType });
    return;
  }

  if (!MessageID) {
    logger.warn({ body }, "Postmark webhook missing MessageID");
    res.status(400).json({ error: "MessageID is required" });
    return;
  }

  const bounceReason = isSpamComplaint
    ? "SpamComplaint"
    : (Description ?? Details ?? Type ?? "HardBounce");

  try {
    const [updated] = await db
      .update(emailMessagesTable)
      .set({ status: "bounced", bounceReason })
      .where(eq(emailMessagesTable.postmarkMessageId, MessageID))
      .returning({
        id: emailMessagesTable.id,
        workspaceId: emailMessagesTable.workspaceId,
      });

    if (!updated) {
      logger.warn({ MessageID }, "Postmark webhook: no email_messages row found for MessageID");
      res.json({ ok: true, handled: true, found: false });
      return;
    }

    await db.insert(auditLogsTable).values({
      workspaceId: updated.workspaceId,
      action: "email.bounced",
      targetType: "email_message",
      targetId: updated.id,
      diffJson: { recordType: RecordType, type: Type, bounceReason, messageId: MessageID },
    });

    logger.info({ MessageID, emailMessageId: updated.id, bounceReason }, "Email bounced — status updated");

    res.json({ ok: true, handled: true, emailMessageId: updated.id });
  } catch (err) {
    logger.error({ err, MessageID }, "Postmark webhook processing failed");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
