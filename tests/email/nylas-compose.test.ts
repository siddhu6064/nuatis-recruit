/**
 * Tests for Batch 6A.4 — net-new compose.
 *
 * Covers:
 *  1. Happy path: email_threads + email_messages rows created, status='sent',
 *     nylas_thread_id populated from Nylas response
 *  2. Happy path: audit_log written with mode='compose' in diff_json
 *  3. grant_missing: no active connected account → code: 'grant_missing'
 *  4. candidate_not_found: candidateId from different workspace → code: 'candidate_not_found'
 *  5. Nylas send fails: thread row persists, message status='failed', bounce_reason set
 *  6. Nylas send fails: audit NOT written
 *  7. validateComposeParams: rejects empty subject
 *  8. validateComposeParams: rejects malformed 'to' address
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { createTestTenant, cleanTestData, pool } from "../helpers/db";
import {
  _setTestNylasClient,
  type NylasClientInterface,
} from "../../artifacts/api-server/src/lib/email/nylas";
import {
  composeEmailFn,
  validateComposeParams,
} from "../../artifacts/api-server/src/lib/email/compose-email";

const PREFIX = "nylas-compose-test";

type Tenant = { orgId: string; workspaceId: string; userId: string };
let tenantA: Tenant;
let tenantB: Tenant;

const grantIdA = `grant-compose-a-${Date.now()}`;
const recruiterEmail = "recruiter@compose-company.example.com";

// ── DB helpers ─────────────────────────────────────────────────────────────

async function insertConnectedAccount(
  workspaceId: string,
  userId: string,
  grantId: string,
  email: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO connected_email_accounts
         (workspace_id, user_id, provider, email_address, nylas_grant_id, status)
       VALUES ($1, $2, 'gmail', $3, $4, 'active')`,
      [workspaceId, userId, email, grantId],
    );
  } finally {
    client.release();
  }
}

async function insertCandidate(workspaceId: string): Promise<string> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ id: string }>(
      `INSERT INTO candidates (workspace_id, name, emails)
       VALUES ($1, 'Bob Compose', ARRAY['bob@candidate.example.com']::text[])
       RETURNING id`,
      [workspaceId],
    );
    return res.rows[0].id;
  } finally {
    client.release();
  }
}

async function queryMessage(id: string): Promise<Record<string, unknown> | undefined> {
  const client = await pool.connect();
  try {
    const res = await client.query(`SELECT * FROM email_messages WHERE id = $1`, [id]);
    return res.rows[0] as Record<string, unknown> | undefined;
  } finally {
    client.release();
  }
}

async function queryThread(id: string): Promise<Record<string, unknown> | undefined> {
  const client = await pool.connect();
  try {
    const res = await client.query(`SELECT * FROM email_threads WHERE id = $1`, [id]);
    return res.rows[0] as Record<string, unknown> | undefined;
  } finally {
    client.release();
  }
}

async function queryAuditLogs(
  workspaceId: string,
  action: string,
): Promise<Record<string, unknown>[]> {
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

/** Each call returns a client with a fresh, unique nylasThreadId so tests don't collide on the unique index. */
function makeSuccessClient(): { client: NylasClientInterface; nylasThreadId: string } {
  const nylasThreadId = `thr-compose-${randomUUID()}`;
  const client: NylasClientInterface = {
    createAuthUrl: () => "",
    exchangeCode: async () => ({ grantId: "", email: "", provider: "" }),
    getMessage: async () => ({ id: "", from: [], date: 0 }),
    revokeGrant: async () => undefined,
    sendMessage: async () => ({
      nylasMessageId: `nylas-compose-${randomUUID()}`,
      sentAt: new Date(),
      nylasThreadId,
    }),
  };
  return { client, nylasThreadId };
}

function makeFailingClient(msg = "Compose SMTP timeout"): NylasClientInterface {
  return {
    createAuthUrl: () => "",
    exchangeCode: async () => ({ grantId: "", email: "", provider: "" }),
    getMessage: async () => ({ id: "", from: [], date: 0 }),
    revokeGrant: async () => undefined,
    sendMessage: async () => { throw new Error(msg); },
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

// ── 1. Happy path — rows created, status='sent', nylas_thread_id populated ─

describe("composeEmailFn — happy path", () => {
  it("creates thread + message rows with status='sent' and nylas_thread_id from Nylas", async () => {
    const candidateId = await insertCandidate(tenantA.workspaceId);
    const { client, nylasThreadId } = makeSuccessClient();
    _setTestNylasClient(client);

    const result = await composeEmailFn({
      candidateId,
      workspaceId: tenantA.workspaceId,
      userId: tenantA.userId,
      to: "candidate@example.com",
      subject: "Interview invitation",
      body: "Hi Bob, we'd like to schedule a call.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Message row
    const msg = await queryMessage(result.emailMessageId);
    expect(msg).toBeTruthy();
    expect((msg as { status: string }).status).toBe("sent");
    expect((msg as { direction: string }).direction).toBe("outbound");
    expect((msg as { nylas_message_id: unknown }).nylas_message_id).toBeTruthy();
    expect((msg as { in_reply_to: unknown }).in_reply_to).toBeNull();

    // Thread row — nylas_thread_id comes from Nylas response (captured per-client instance)
    const thread = await queryThread(result.threadId);
    expect(thread).toBeTruthy();
    expect((thread as { nylas_thread_id: string }).nylas_thread_id).toBe(nylasThreadId);
    expect(Number((thread as { message_count: unknown }).message_count)).toBe(1);
    expect((thread as { candidate_id: string }).candidate_id).toBe(candidateId);
  });
});

// ── 2. Happy path — audit log with mode:'compose' ─────────────────────────

describe("composeEmailFn — audit log", () => {
  it("writes email.sent audit_log with mode='compose' in diff_json", async () => {
    const candidateId = await insertCandidate(tenantA.workspaceId);
    const { client } = makeSuccessClient();
    _setTestNylasClient(client);

    const result = await composeEmailFn({
      candidateId,
      workspaceId: tenantA.workspaceId,
      userId: tenantA.userId,
      to: "candidate@example.com",
      subject: "Audit test compose",
      body: "Body text for audit test.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await queryAuditLogs(tenantA.workspaceId, "email.sent");
    const row = rows.find((r) => (r.target_id as string) === result.emailMessageId);
    expect(row).toBeTruthy();

    // diff_json is a jsonb column — pg driver returns it already parsed as an object
    const diff = (row as { diff_json: Record<string, unknown> }).diff_json;
    expect(diff.mode).toBe("compose");
    expect(diff.threadId).toBe(result.threadId);
  });
});

// ── 3. grant_missing ──────────────────────────────────────────────────────

describe("composeEmailFn — no active grant", () => {
  it("returns grant_missing when user has no connected account in workspace", async () => {
    const candidateId = await insertCandidate(tenantA.workspaceId);
    // tenantB.userId has no connected account in workspace A
    const result = await composeEmailFn({
      candidateId,
      workspaceId: tenantA.workspaceId,
      userId: tenantB.userId,
      to: "candidate@example.com",
      subject: "Test subject",
      body: "Test body",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("grant_missing");
  });
});

// ── 4. candidate_not_found (cross-workspace) ──────────────────────────────

describe("composeEmailFn — cross-workspace isolation", () => {
  it("returns candidate_not_found when candidateId belongs to different workspace", async () => {
    const candidateId = await insertCandidate(tenantA.workspaceId);

    const result = await composeEmailFn({
      candidateId,
      workspaceId: tenantB.workspaceId, // wrong workspace
      userId: tenantB.userId,
      to: "candidate@example.com",
      subject: "Cross-workspace compose",
      body: "Body",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("candidate_not_found");
  });
});

// ── 5. Nylas send fails — thread persists, message='failed' ──────────────

describe("composeEmailFn — Nylas send failure", () => {
  it("leaves thread in place and message at status='failed' with bounce_reason", async () => {
    const candidateId = await insertCandidate(tenantA.workspaceId);
    _setTestNylasClient(makeFailingClient());

    const result = await composeEmailFn({
      candidateId,
      workspaceId: tenantA.workspaceId,
      userId: tenantA.userId,
      to: "candidate@example.com",
      subject: "Will fail",
      body: "This email will fail at Nylas",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("send_failed");

    // Thread still exists (not rolled back)
    const thread = await queryThread(result.threadId);
    expect(thread).toBeTruthy();

    // Message row at 'failed' with bounce_reason (queued-row invariant)
    const msg = await queryMessage(result.emailMessageId);
    expect((msg as { status: string }).status).toBe("failed");
    expect((msg as { bounce_reason: string }).bounce_reason).toContain("SMTP timeout");
  });
});

// ── 6. Nylas fails — audit NOT written ───────────────────────────────────

describe("composeEmailFn — audit not written on failure", () => {
  it("does not write an audit_log row when Nylas send fails", async () => {
    const candidateId = await insertCandidate(tenantA.workspaceId);
    _setTestNylasClient(makeFailingClient("Audit suppressed error"));

    const auditsBefore = await queryAuditLogs(tenantA.workspaceId, "email.sent");
    const countBefore = auditsBefore.length;

    const result = await composeEmailFn({
      candidateId,
      workspaceId: tenantA.workspaceId,
      userId: tenantA.userId,
      to: "candidate@example.com",
      subject: "Audit suppressed",
      body: "Body",
    });

    expect(result.ok).toBe(false);

    const auditsAfter = await queryAuditLogs(tenantA.workspaceId, "email.sent");
    expect(auditsAfter.length).toBe(countBefore);
  });
});

// ── 7–8. Validation unit tests (no DB) ───────────────────────────────────

describe("validateComposeParams", () => {
  it("rejects empty subject", () => {
    const err = validateComposeParams({
      to: "alice@example.com",
      subject: "   ",
      body: "Hello",
    });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("subject");
  });

  it("rejects malformed 'to' address", () => {
    const err = validateComposeParams({
      to: "not-an-email",
      subject: "Test",
      body: "Hello",
    });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("to");
  });
});
