/**
 * Core ingest logic for a Nylas inbound message.
 *
 * Extracted from the Inngest function so it can be called directly in tests
 * without needing the Inngest dev server. The Inngest function wraps this.
 *
 * Uses raw pg.Client (not the pool with SET ROLE) because background jobs
 * don't have an HTTP user context. This is intentional — same pattern used
 * by all other Inngest functions in inngest.ts.
 *
 * Idempotent: uses ON CONFLICT DO NOTHING on nylas_message_id.
 */
import pg from "pg";
import { getMessage } from "./nylas";
import { logger } from "../logger";

const { Client } = pg;

async function dbQuery(sql: string, params: unknown[] = []) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

export type IngestResult = {
  skipped: boolean;
  reason?: string;
  emailThreadId?: string;
  emailMessageId?: string;
};

export async function ingestNylasMessageFn(params: {
  grantId: string;
  messageId: string;
  threadId: string;
}): Promise<IngestResult> {
  const { grantId, messageId, threadId } = params;

  // 1. Find connected account by grant_id
  const accountRes = await dbQuery(
    `SELECT workspace_id, email_address
     FROM connected_email_accounts
     WHERE nylas_grant_id = $1 AND status = 'active'
     LIMIT 1`,
    [grantId],
  );

  if (!accountRes.rows.length) {
    logger.warn({ grantId }, "ingestNylasMessage: no active connected account for grant");
    return { skipped: true, reason: "no_account_for_grant" };
  }

  const { workspace_id: workspaceId, email_address: accountEmail } =
    accountRes.rows[0] as { workspace_id: string; email_address: string };

  // 2. Update last_sync_at for the account
  await dbQuery(
    `UPDATE connected_email_accounts SET last_sync_at = now()
     WHERE nylas_grant_id = $1`,
    [grantId],
  );

  // 3. Fetch full message from Nylas
  let message;
  try {
    message = await getMessage(grantId, messageId);
  } catch (err) {
    logger.error({ err, grantId, messageId }, "ingestNylasMessage: getMessage failed");
    throw err;
  }

  // 4. Direction check — skip outbound (recruiter's own sent mail)
  const fromEmail = message.from?.[0]?.email?.toLowerCase() ?? "";
  if (fromEmail === accountEmail.toLowerCase()) {
    logger.info({ messageId, fromEmail }, "ingestNylasMessage: skipping outbound message");
    return { skipped: true, reason: "outbound" };
  }

  // 5. Candidate lookup by from_address (workspace-scoped)
  const candidateRes = await dbQuery(
    `SELECT id FROM candidates
     WHERE workspace_id = $1 AND $2 = ANY(emails)
     ORDER BY last_activity_at DESC NULLS LAST
     LIMIT 1`,
    [workspaceId, fromEmail],
  );
  const candidateId: string | null = candidateRes.rows[0]?.id ?? null;

  // 6. Upsert email_thread by nylas_thread_id
  const effectiveThreadId = message.threadId ?? threadId;
  const subject = message.subject ?? "(no subject)";
  const sentAt = message.date
    ? new Date(message.date * 1000)
    : new Date();

  const threadRes = await dbQuery(
    `INSERT INTO email_threads (workspace_id, candidate_id, subject, nylas_thread_id, last_message_at, message_count)
     VALUES ($1, $2, $3, $4, $5, 1)
     ON CONFLICT (nylas_thread_id) WHERE nylas_thread_id IS NOT NULL
     DO UPDATE SET
       last_message_at = GREATEST(EXCLUDED.last_message_at, email_threads.last_message_at),
       candidate_id    = COALESCE(email_threads.candidate_id, EXCLUDED.candidate_id),
       message_count   = email_threads.message_count + 1
     RETURNING id`,
    [workspaceId, candidateId, subject, effectiveThreadId, sentAt.toISOString()],
  );
  const emailThreadId: string = threadRes.rows[0].id;

  // 7. Insert email_message — idempotent on nylas_message_id
  const toAddresses = (message.to ?? []).map((e) => e.email);
  const ccAddresses = (message.cc ?? []).map((e) => e.email);
  const bccAddresses = (message.bcc ?? []).map((e) => e.email);
  const bodyText = message.snippet ?? "";
  const bodyHtml = message.body ?? null;

  const msgRes = await dbQuery(
    `INSERT INTO email_messages
       (workspace_id, thread_id, nylas_message_id, direction, from_address,
        to_addresses, cc_addresses, bcc_addresses, subject, body_text, body_html,
        sent_at, status)
     VALUES ($1, $2, $3, 'inbound', $4, $5::text[], $6::text[], $7::text[],
             $8, $9, $10, $11, 'received')
     ON CONFLICT (nylas_message_id) WHERE nylas_message_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      workspaceId,
      emailThreadId,
      messageId,
      fromEmail,
      toAddresses,
      ccAddresses,
      bccAddresses,
      subject,
      bodyText,
      bodyHtml,
      sentAt.toISOString(),
    ],
  );

  const emailMessageId: string | undefined = msgRes.rows[0]?.id;

  if (!emailMessageId) {
    // DO NOTHING branch — duplicate message
    logger.info({ messageId }, "ingestNylasMessage: duplicate nylas_message_id — skipped");
    return { skipped: true, reason: "duplicate", emailThreadId };
  }

  logger.info(
    { messageId, emailThreadId, emailMessageId, candidateId, workspaceId },
    "ingestNylasMessage: message ingested",
  );

  return { skipped: false, emailThreadId, emailMessageId };
}
