/**
 * Core outbound reply logic.
 *
 * Extracted from the HTTP route so tests can call it directly without the
 * Inngest dev server or a running Express process (same pattern as
 * ingest-nylas-message.ts). The HTTP route is a thin wrapper around this.
 *
 * Flow:
 *  1. Verify thread belongs to workspace (manual workspace check — no RLS
 *     here since raw pg is used, same as ingest-nylas-message.ts).
 *  2. Find most recent inbound message for reply targeting.
 *  3. Resolve sender's active Nylas grant.
 *  4. INSERT email_messages (status='queued') + UPDATE email_threads
 *     in a single DB transaction — so thread counts stay consistent even if
 *     the Nylas call fails partway through.
 *  5. Call nylas.sendMessage. On success → UPDATE to 'sent'. On failure →
 *     UPDATE to 'failed'; row stays queryable for Retry.
 *  6. On success: write audit_log (email.sent) + activities row if the
 *     thread has a candidate_id.
 *
 * Subject de-duplication rule:
 *   Strip all leading "Re: " / "RE: " / "re: " prefixes (case-insensitive,
 *   with any amount of whitespace), then prepend exactly one "Re: ".
 *   "Hello" → "Re: Hello"
 *   "Re: Hello" → "Re: Hello"  (no doubling)
 *   "RE: Re: Hello" → "Re: Hello"
 */
import pg from "pg";
import { sendMessage } from "./nylas";
import { logger } from "../logger";

const { Client } = pg;

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// ── Subject helper ─────────────────────────────────────────────────────────

/** Strip leading Re:/RE:/re: prefixes and prepend exactly one "Re: ". */
export function computeReplySubject(original: string): string {
  const stripped = original.replace(/^(re:\s*)+/i, "").trim();
  return `Re: ${stripped}`;
}

// ── Result type ────────────────────────────────────────────────────────────

export type SendReplyResult =
  | { ok: true; emailMessageId: string; status: "sent" }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "no_inbound_message" }
  | { ok: false; code: "grant_missing" }
  | { ok: false; code: "send_failed"; emailMessageId: string; bounceReason: string };

// ── Core function ──────────────────────────────────────────────────────────

export async function sendReplyFn(params: {
  threadId: string;
  workspaceId: string;
  userId: string;
  body: string;
}): Promise<SendReplyResult> {
  const { threadId, workspaceId, userId, body } = params;

  return withClient(async (client) => {
    // 1. Verify thread belongs to workspace
    const threadRes = await client.query<{
      id: string;
      subject: string;
      candidate_id: string | null;
    }>(
      `SELECT id, subject, candidate_id
       FROM email_threads
       WHERE id = $1 AND workspace_id = $2
       LIMIT 1`,
      [threadId, workspaceId],
    );
    if (!threadRes.rows.length) {
      return { ok: false, code: "not_found" };
    }
    const thread = threadRes.rows[0];

    // 2. Find most recent inbound message for reply target (In-Reply-To)
    const inboundRes = await client.query<{
      id: string;
      nylas_message_id: string | null;
      from_address: string;
    }>(
      `SELECT id, nylas_message_id, from_address
       FROM email_messages
       WHERE thread_id = $1 AND direction = 'inbound'
       ORDER BY sent_at DESC
       LIMIT 1`,
      [threadId],
    );
    if (!inboundRes.rows.length) {
      return { ok: false, code: "no_inbound_message" };
    }
    const replyTarget = inboundRes.rows[0];

    // 3. Resolve sender's active Nylas grant
    const grantRes = await client.query<{
      id: string;
      nylas_grant_id: string;
      email_address: string;
    }>(
      `SELECT id, nylas_grant_id, email_address
       FROM connected_email_accounts
       WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'
       LIMIT 1`,
      [workspaceId, userId],
    );
    if (!grantRes.rows.length) {
      return { ok: false, code: "grant_missing" };
    }
    const account = grantRes.rows[0];

    // 4. Compute reply subject + other fields
    const replySubject = computeReplySubject(thread.subject);
    const toAddress = replyTarget.from_address;
    const now = new Date();

    // 5. INSERT email_messages (status='queued') + UPDATE email_threads — single tx
    await client.query("BEGIN");
    let emailMessageId: string;
    try {
      const msgRes = await client.query<{ id: string }>(
        `INSERT INTO email_messages
           (workspace_id, thread_id, direction, from_address,
            to_addresses, cc_addresses, bcc_addresses,
            subject, body_text, in_reply_to, sent_at, status)
         VALUES ($1, $2, 'outbound', $3,
                 ARRAY[$4]::text[], '{}'::text[], '{}'::text[],
                 $5, $6, $7, $8, 'queued')
         RETURNING id`,
        [
          workspaceId,
          threadId,
          account.email_address,
          toAddress,
          replySubject,
          body,
          replyTarget.nylas_message_id,
          now.toISOString(),
        ],
      );
      emailMessageId = msgRes.rows[0].id;

      await client.query(
        `UPDATE email_threads
         SET last_message_at = $1,
             message_count   = message_count + 1
         WHERE id = $2`,
        [now.toISOString(), threadId],
      );

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK").catch(() => {});
      throw txErr;
    }

    // 6. Call Nylas sendMessage — after the COMMIT so a network failure
    //    leaves the row at status='failed' rather than losing it entirely.
    let nylasMessageId: string;
    let sentAt: Date;
    try {
      const result = await sendMessage(account.nylas_grant_id, {
        to: toAddress,
        subject: replySubject,
        body,
        replyToMessageId: replyTarget.nylas_message_id ?? undefined,
      });
      nylasMessageId = result.nylasMessageId;
      sentAt = result.sentAt;
    } catch (sendErr) {
      const bounceReason = sendErr instanceof Error ? sendErr.message : String(sendErr);
      await client.query(
        `UPDATE email_messages
         SET status = 'failed', bounce_reason = $1
         WHERE id = $2`,
        [bounceReason, emailMessageId],
      );
      logger.error({ sendErr, emailMessageId, threadId }, "Nylas sendMessage failed — row marked failed");
      return { ok: false, code: "send_failed", emailMessageId, bounceReason };
    }

    // 7. Mark email_messages sent
    await client.query(
      `UPDATE email_messages
       SET status = 'sent', nylas_message_id = $1, sent_at = $2
       WHERE id = $3`,
      [nylasMessageId, sentAt.toISOString(), emailMessageId],
    );

    // 8. Audit log
    await client.query(
      `INSERT INTO audit_logs (workspace_id, action, target_type, target_id, diff_json)
       VALUES ($1, 'email.sent', 'email_message', $2, $3)`,
      [
        workspaceId,
        emailMessageId,
        JSON.stringify({
          threadId,
          grantId: account.nylas_grant_id,
          nylasMessageId,
          to: toAddress,
        }),
      ],
    );

    // 9. Candidate activity (only if thread is linked to a candidate)
    if (thread.candidate_id) {
      await client.query(
        `INSERT INTO activities (workspace_id, candidate_id, type, payload)
         VALUES ($1, $2, 'email_sent', $3)`,
        [
          workspaceId,
          thread.candidate_id,
          JSON.stringify({
            subject: replySubject,
            fromUser: account.email_address,
            messageId: emailMessageId,
          }),
        ],
      );
    }

    logger.info({ emailMessageId, nylasMessageId, threadId }, "Outbound reply sent");
    return { ok: true, emailMessageId, status: "sent" };
  });
}
