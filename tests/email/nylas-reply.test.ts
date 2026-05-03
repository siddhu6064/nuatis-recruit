/**
 * Tests for Batch 6A.3 — outbound reply.
 *
 * Covers:
 *  1. sendMessage wrapper: correct Nylas params including replyToMessageId
 *  2. computeReplySubject: de-duplication logic (unit)
 *  3. Happy path: row status='sent', thread updated, audit written
 *  4. No grant → grant_missing result
 *  5. Nylas send fails → row status='failed' with bounceReason
 *  6. Cross-workspace thread → not_found (workspace isolation)
 *  7. No inbound messages → no_inbound_message result
 *  8. Audit log written on success
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { createTestTenant, cleanTestData, pool } from "../helpers/db";
import {
  _setTestNylasClient,
  type NylasClientInterface,
  type NylasSendParams,
} from "../../artifacts/api-server/src/lib/email/nylas";
import { sendReplyFn, computeReplySubject } from "../../artifacts/api-server/src/lib/email/send-reply";

const PREFIX = "nylas-reply-test";

type Tenant = { orgId: string; workspaceId: string; userId: string };
let tenantA: Tenant;
let tenantB: Tenant;

const grantIdA = `grant-reply-a-${Date.now()}`;
const recruiterEmail = "recruiter@reply-company-a.example.com";
const candidateEmail = "alice-reply@candidate.example.com";

// ── DB helpers ─────────────────────────────────────────────────────────────

async function insertConnectedAccount(
  workspaceId: string,
  userId: string,
  grantId: string,
  email: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO connected_email_accounts
         (workspace_id, user_id, provider, email_address, nylas_grant_id, status)
       VALUES ($1, $2, 'gmail', $3, $4, 'active')
       RETURNING id`,
      [workspaceId, userId, email, grantId],
    );
    return res.rows[0].id as string;
  } finally {
    client.release();
  }
}

async function insertCandidate(workspaceId: string, email: string): Promise<string> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO candidates (workspace_id, name, emails)
       VALUES ($1, 'Alice Reply', ARRAY[$2]::text[])
       RETURNING id`,
      [workspaceId, email],
    );
    return res.rows[0].id as string;
  } finally {
    client.release();
  }
}

async function insertThread(
  workspaceId: string,
  subject: string,
  candidateId?: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    const nylasThreadId = `thr-${randomUUID()}`;
    const res = await client.query(
      `INSERT INTO email_threads
         (workspace_id, candidate_id, subject, nylas_thread_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [workspaceId, candidateId ?? null, subject, nylasThreadId],
    );
    return res.rows[0].id as string;
  } finally {
    client.release();
  }
}

async function insertInboundMessage(
  workspaceId: string,
  threadId: string,
  opts: { fromEmail?: string; nylasMessageId?: string } = {},
): Promise<string> {
  const client = await pool.connect();
  try {
    const nylasMessageId = opts.nylasMessageId ?? `msg-${randomUUID()}`;
    const res = await client.query(
      `INSERT INTO email_messages
         (workspace_id, thread_id, nylas_message_id, direction, from_address,
          to_addresses, subject, body_text, sent_at, status)
       VALUES ($1, $2, $3, 'inbound', $4, ARRAY['r@x.com']::text[],
               'Test', 'Hello', now() - interval '5 minutes', 'received')
       RETURNING id`,
      [workspaceId, threadId, nylasMessageId, opts.fromEmail ?? candidateEmail],
    );
    return res.rows[0].id as string;
  } finally {
    client.release();
  }
}

async function queryMessageById(id: string) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT * FROM email_messages WHERE id = $1`,
      [id],
    );
    return res.rows[0] as Record<string, unknown> | undefined;
  } finally {
    client.release();
  }
}

async function queryThread(id: string) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT * FROM email_threads WHERE id = $1`,
      [id],
    );
    return res.rows[0] as Record<string, unknown> | undefined;
  } finally {
    client.release();
  }
}

async function queryAuditLogs(workspaceId: string, action: string) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT * FROM audit_logs WHERE workspace_id = $1 AND action = $2`,
      [workspaceId, action],
    );
    return res.rows as Record<string, unknown>[];
  } finally {
    client.release();
  }
}

// ── Mock client factories ─────────────────────────────────────────────────

function makeSendCapture() {
  const calls: { grantId: string; params: NylasSendParams }[] = [];
  const mock: NylasClientInterface = {
    createAuthUrl: () => "",
    exchangeCode: async () => ({ grantId: "", email: "", provider: "" }),
    getMessage: async () => ({ id: "", from: [], date: 0 }),
    revokeGrant: async () => undefined,
    sendMessage: async (grantId, params) => {
      calls.push({ grantId, params });
      return { nylasMessageId: `nylas-sent-${randomUUID()}`, sentAt: new Date() };
    },
  };
  return { mock, calls };
}

function makeFailingClient(errorMsg = "Nylas connection refused"): NylasClientInterface {
  return {
    createAuthUrl: () => "",
    exchangeCode: async () => ({ grantId: "", email: "", provider: "" }),
    getMessage: async () => ({ id: "", from: [], date: 0 }),
    revokeGrant: async () => undefined,
    sendMessage: async () => { throw new Error(errorMsg); },
  };
}

// ── Setup / teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  tenantA = await createTestTenant(PREFIX, "A", { emailV1Enabled: true });
  tenantB = await createTestTenant(PREFIX, "B", { emailV1Enabled: true });
  await insertConnectedAccount(tenantA.workspaceId, tenantA.userId, grantIdA, recruiterEmail);
});

afterAll(async () => {
  _setTestNylasClient(null);
  await cleanTestData(PREFIX);
});

afterEach(() => {
  _setTestNylasClient(null);
});

// ── 1. sendMessage wrapper ─────────────────────────────────────────────────

describe("sendMessage wrapper — correct Nylas params", () => {
  it("calls Nylas messages.send with replyToMessageId when provided", async () => {
    const { mock, calls } = makeSendCapture();
    _setTestNylasClient(mock);

    const { sendMessage } = await import(
      "../../artifacts/api-server/src/lib/email/nylas"
    );
    const result = await sendMessage("grant_test", {
      to: "candidate@example.com",
      subject: "Re: Hello",
      body: "Thanks for reaching out!",
      replyToMessageId: "nylas_msg_abc123",
    });

    expect(result.nylasMessageId).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0].grantId).toBe("grant_test");
    expect(calls[0].params.to).toBe("candidate@example.com");
    expect(calls[0].params.replyToMessageId).toBe("nylas_msg_abc123");
    expect(calls[0].params.subject).toBe("Re: Hello");
  });
});

// ── 2. computeReplySubject ─────────────────────────────────────────────────

describe("computeReplySubject — de-duplication", () => {
  it("prefixes plain subject with Re:", () => {
    expect(computeReplySubject("Hello there")).toBe("Re: Hello there");
  });

  it("does not double-prefix an already-prefixed subject", () => {
    expect(computeReplySubject("Re: Hello there")).toBe("Re: Hello there");
  });

  it("collapses multiple Re: prefixes", () => {
    expect(computeReplySubject("RE: Re: Hello there")).toBe("Re: Hello there");
  });

  it("handles case-insensitive prefix stripping", () => {
    expect(computeReplySubject("re:Hello there")).toBe("Re: Hello there");
  });
});

// ── 3. Happy path ─────────────────────────────────────────────────────────

describe("sendReplyFn — happy path", () => {
  it("creates email_messages row at status='sent' and increments thread.message_count", async () => {
    const candidateId = await insertCandidate(tenantA.workspaceId, candidateEmail);
    const threadId = await insertThread(tenantA.workspaceId, "Hello from candidate", candidateId);
    const nylasMessageId = `nylas-inbound-${randomUUID()}`;
    await insertInboundMessage(tenantA.workspaceId, threadId, { nylasMessageId });

    const threadBefore = await queryThread(threadId);
    const countBefore = Number(
      (threadBefore as { message_count: unknown }).message_count ?? 0,
    );

    const { mock } = makeSendCapture();
    _setTestNylasClient(mock);

    const result = await sendReplyFn({
      threadId,
      workspaceId: tenantA.workspaceId,
      userId: tenantA.userId,
      body: "Thanks for reaching out!",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return; // type narrowing

    const row = await queryMessageById(result.emailMessageId);
    expect(row).toBeTruthy();
    expect((row as { status: string }).status).toBe("sent");
    expect((row as { direction: string }).direction).toBe("outbound");
    expect((row as { nylas_message_id: unknown }).nylas_message_id).toBeTruthy();
    expect((row as { in_reply_to: string }).in_reply_to).toBe(nylasMessageId);

    const threadAfter = await queryThread(threadId);
    expect(Number((threadAfter as { message_count: unknown }).message_count)).toBeGreaterThan(countBefore);
  });
});

// ── 4. No grant ────────────────────────────────────────────────────────────

describe("sendReplyFn — no active grant", () => {
  it("returns grant_missing when the user has no connected account", async () => {
    const threadId = await insertThread(tenantA.workspaceId, "Thread for no-grant test");
    await insertInboundMessage(tenantA.workspaceId, threadId);

    // Use tenantB's userId — they have no connected account in workspace A
    const result = await sendReplyFn({
      threadId,
      workspaceId: tenantA.workspaceId,
      userId: tenantB.userId, // no connected_email_accounts row for this user in ws A
      body: "Trying to send without a grant",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("grant_missing");
  });
});

// ── 5. Nylas send failure ─────────────────────────────────────────────────

describe("sendReplyFn — Nylas send failure", () => {
  it("leaves email_messages row at status='failed' with bounceReason set", async () => {
    const threadId = await insertThread(tenantA.workspaceId, "Thread for send-fail test");
    await insertInboundMessage(tenantA.workspaceId, threadId);

    _setTestNylasClient(makeFailingClient("SMTP connection timeout"));

    const result = await sendReplyFn({
      threadId,
      workspaceId: tenantA.workspaceId,
      userId: tenantA.userId,
      body: "This will fail at Nylas",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("send_failed");

    const row = await queryMessageById(result.emailMessageId);
    expect((row as { status: string }).status).toBe("failed");
    expect((row as { bounce_reason: string }).bounce_reason).toContain("SMTP connection timeout");
    // Row must exist (queued INSERT before Nylas call — queued-row pattern)
    expect(row).toBeTruthy();
  });
});

// ── 6. Cross-workspace isolation ──────────────────────────────────────────

describe("sendReplyFn — cross-workspace isolation", () => {
  it("returns not_found when threadId belongs to a different workspace", async () => {
    // Create a thread in workspace A
    const threadId = await insertThread(tenantA.workspaceId, "Workspace A thread");
    await insertInboundMessage(tenantA.workspaceId, threadId);

    // Try to reply from workspace B — should not find the thread
    const result = await sendReplyFn({
      threadId,
      workspaceId: tenantB.workspaceId, // wrong workspace
      userId: tenantB.userId,
      body: "Cross-workspace reply attempt",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });
});

// ── 7. No inbound messages ────────────────────────────────────────────────

describe("sendReplyFn — no inbound messages", () => {
  it("returns no_inbound_message when thread has no inbound messages", async () => {
    const threadId = await insertThread(tenantA.workspaceId, "Thread with no inbound");
    // Do NOT insert any inbound messages

    const { mock } = makeSendCapture();
    _setTestNylasClient(mock);

    const result = await sendReplyFn({
      threadId,
      workspaceId: tenantA.workspaceId,
      userId: tenantA.userId,
      body: "Hello",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_inbound_message");
  });
});

// ── 8. Audit log on success ────────────────────────────────────────────────

describe("sendReplyFn — audit log", () => {
  it("writes email.sent audit_log row on successful send", async () => {
    const threadId = await insertThread(tenantA.workspaceId, "Thread for audit test");
    await insertInboundMessage(tenantA.workspaceId, threadId);

    const { mock } = makeSendCapture();
    _setTestNylasClient(mock);

    const result = await sendReplyFn({
      threadId,
      workspaceId: tenantA.workspaceId,
      userId: tenantA.userId,
      body: "Audited reply",
    });

    expect(result.ok).toBe(true);

    const auditRows = await queryAuditLogs(tenantA.workspaceId, "email.sent");
    const auditRow = auditRows.find(
      (r) => result.ok && (r.target_id as string) === result.emailMessageId,
    );
    expect(auditRow).toBeTruthy();
    expect((auditRow as { target_type: string }).target_type).toBe("email_message");
  });
});
