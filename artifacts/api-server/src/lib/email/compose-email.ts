/**
 * Core net-new compose logic (Batch 6A.4).
 *
 * Extracted from the HTTP route so tests call it directly without a running
 * Express process (same pattern as send-reply.ts and ingest-nylas-message.ts).
 *
 * Compose vs. Reply distinction:
 *   - Reply (6A.3): thread already exists, replyToMessageId set, subject prefixed "Re: "
 *   - Compose (6A.4): creates a brand-new email_threads row, replyToMessageId omitted,
 *     subject is user-typed verbatim. nylas_thread_id populated post-send from Nylas response.
 *
 * Queued-row invariant:
 *   INSERT email_threads + INSERT email_messages (status='queued') committed in a single
 *   transaction BEFORE the Nylas call. If Nylas fails, the row stays at status='failed'
 *   with bounce_reason set — still visible in the thread. User can Retry via the 6A.3
 *   Retry button mechanism (re-POST to /reply or /compose with same body).
 *
 * Audit metadata:
 *   mode='compose' in diff_json distinguishes these rows from reply audit rows
 *   (which carry mode omitted / no mode field) for future analytics.
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

// ── Validation ─────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ComposeValidationError = { field: string; message: string };

/**
 * Validate the compose params. Returns null if valid, or an error object.
 * Exported so unit tests can exercise validation without HTTP.
 */
export function validateComposeParams(params: {
  to: string;
  subject: string;
  body: string;
}): ComposeValidationError | null {
  if (!params.to.trim()) return { field: "to", message: "to is required" };
  if (!EMAIL_RE.test(params.to.trim()))
    return { field: "to", message: "to must be a valid email address" };
  if (!params.subject.trim()) return { field: "subject", message: "subject is required" };
  if (!params.body.trim()) return { field: "body", message: "body is required" };
  return null;
}

// ── Result type ────────────────────────────────────────────────────────────

export type ComposeEmailResult =
  | { ok: true; emailMessageId: string; threadId: string; status: "sent" }
  | { ok: false; code: "candidate_not_found" }
  | { ok: false; code: "grant_missing" }
  | {
      ok: false;
      code: "send_failed";
      emailMessageId: string;
      threadId: string;
      bounceReason: string;
    };

// ── Core function ──────────────────────────────────────────────────────────

export async function composeEmailFn(params: {
  candidateId: string;
  workspaceId: string;
  userId: string;
  to: string;
  subject: string;
  body: string;
}): Promise<ComposeEmailResult> {
  const { candidateId, workspaceId, userId, to, subject, body } = params;

  return withClient(async (client) => {
    // 1. Verify candidate belongs to workspace
    const candidateRes = await client.query<{ id: string }>(
      `SELECT id FROM candidates WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [candidateId, workspaceId],
    );
    if (!candidateRes.rows.length) {
      return { ok: false, code: "candidate_not_found" };
    }

    // 2. Resolve sender's active Nylas grant
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

    const now = new Date();

    // 3. Atomic transaction: INSERT email_threads + INSERT email_messages (queued)
    await client.query("BEGIN");
    let threadId: string;
    let emailMessageId: string;
    try {
      const threadRes = await client.query<{ id: string }>(
        `INSERT INTO email_threads
           (workspace_id, candidate_id, subject, last_message_at, message_count)
         VALUES ($1, $2, $3, $4, 0)
         RETURNING id`,
        [workspaceId, candidateId, subject, now.toISOString()],
      );
      threadId = threadRes.rows[0].id;

      const msgRes = await client.query<{ id: string }>(
        `INSERT INTO email_messages
           (workspace_id, thread_id, direction, from_address,
            to_addresses, cc_addresses, bcc_addresses,
            subject, body_text, in_reply_to, sent_at, status)
         VALUES ($1, $2, 'outbound', $3,
                 ARRAY[$4]::text[], '{}'::text[], '{}'::text[],
                 $5, $6, null, $7, 'queued')
         RETURNING id`,
        [workspaceId, threadId, account.email_address, to, subject, body, now.toISOString()],
      );
      emailMessageId = msgRes.rows[0].id;

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK").catch(() => {});
      throw txErr;
    }

    // 4. Call nylas.sendMessage — replyToMessageId intentionally omitted (new thread)
    let nylasMessageId: string;
    let sentAt: Date;
    let nylasThreadId: string | undefined;
    try {
      const result = await sendMessage(account.nylas_grant_id, {
        to,
        subject,
        body,
        // replyToMessageId: omitted — Nylas will create a new thread
      });
      nylasMessageId = result.nylasMessageId;
      sentAt = result.sentAt;
      nylasThreadId = result.nylasThreadId;
    } catch (sendErr) {
      const bounceReason = sendErr instanceof Error ? sendErr.message : String(sendErr);
      await client.query(
        `UPDATE email_messages SET status = 'failed', bounce_reason = $1 WHERE id = $2`,
        [bounceReason, emailMessageId],
      );
      logger.error(
        { sendErr, emailMessageId, threadId },
        "Nylas sendMessage failed on compose — row marked failed",
      );
      return { ok: false, code: "send_failed", emailMessageId, threadId, bounceReason };
    }

    // 5. Mark message sent + populate thread nylas_thread_id and message_count
    await client.query(
      `UPDATE email_messages
       SET status = 'sent', nylas_message_id = $1, sent_at = $2
       WHERE id = $3`,
      [nylasMessageId, sentAt.toISOString(), emailMessageId],
    );
    await client.query(
      `UPDATE email_threads
       SET nylas_thread_id = $1, message_count = 1, last_message_at = $2
       WHERE id = $3`,
      [nylasThreadId ?? null, sentAt.toISOString(), threadId],
    );

    // 6. Audit log — mode:'compose' distinguishes from reply audits
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
          to,
          mode: "compose",
        }),
      ],
    );

    // 7. Candidate activity
    await client.query(
      `INSERT INTO activities (workspace_id, candidate_id, type, payload)
       VALUES ($1, $2, 'email_sent', $3)`,
      [
        workspaceId,
        candidateId,
        JSON.stringify({
          subject,
          fromUser: account.email_address,
          messageId: emailMessageId,
          mode: "compose",
        }),
      ],
    );

    logger.info({ emailMessageId, nylasMessageId, threadId }, "Compose email sent");
    return { ok: true, emailMessageId, threadId, status: "sent" };
  });
}
