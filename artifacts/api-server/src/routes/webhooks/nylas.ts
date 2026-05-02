/**
 * POST /api/webhooks/nylas
 *
 * Receives real-time events from Nylas v3.
 * Validates HMAC-SHA256 signature in x-nylas-signature header.
 *
 * Design: Accept payload → fire Inngest event → return 200 quickly (<2s).
 * Heavy work (getMessage, DB writes) runs in the Inngest function.
 * Nylas retries on non-2xx; Inngest idempotency guards against duplicates.
 *
 * Supported event types:
 *   message.created  → nylas.message_received
 *   grant.expired    → nylas.grant_expired
 *   (all others)     → accepted with 200 and ignored
 *
 * Signature scheme (Nylas v3):
 *   header: x-nylas-signature
 *   algorithm: HMAC-SHA256
 *   key: NYLAS_WEBHOOK_SECRET
 *   message: raw UTF-8 request body
 *   encoding: lowercase hex
 */
import { createHmac, timingSafeEqual } from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { inngest } from "../../lib/inngest";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

function verifyNylasSignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env.NYLAS_WEBHOOK_SECRET;
  if (!secret) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  let expectedBuf: Buffer;
  let receivedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, "hex");
    receivedBuf = Buffer.from(signature, "hex");
  } catch {
    return false;
  }

  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}

router.post("/webhooks/nylas", async (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

  if (!rawBody) {
    logger.warn("Nylas webhook: rawBody not available — check express.json verify callback");
    res.status(400).json({ error: "Cannot verify signature: raw body unavailable" });
    return;
  }

  const signature = req.headers["x-nylas-signature"] as string | undefined;
  if (!signature) {
    res.status(401).json({ error: "Missing x-nylas-signature header" });
    return;
  }

  if (!verifyNylasSignature(rawBody, signature)) {
    logger.warn("Nylas webhook: HMAC signature mismatch — rejecting");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const body = req.body as {
    type?: string;
    data?: {
      grant_id?: string;
      object?: {
        id?: string;
        thread_id?: string;
      };
    };
  };

  const eventType = body.type ?? "";
  const grantId = body.data?.grant_id ?? "";
  const messageId = body.data?.object?.id ?? "";
  const threadId = body.data?.object?.thread_id ?? "";

  logger.info({ eventType, grantId, messageId }, "Nylas webhook received");

  try {
    if (eventType === "message.created") {
      await inngest.send({
        name: "nylas.message_received",
        data: { grantId, messageId, threadId },
      });
    } else if (eventType === "grant.expired") {
      await inngest.send({
        name: "nylas.grant_expired",
        data: { grantId },
      });
    } else {
      logger.info({ eventType }, "Nylas webhook: unhandled event type — ignoring");
    }
  } catch (err) {
    // Log but still return 200 — Inngest is best-effort from the webhook handler
    logger.error({ err, eventType }, "Nylas webhook: failed to send Inngest event");
  }

  res.json({ ok: true });
});

export default router;
