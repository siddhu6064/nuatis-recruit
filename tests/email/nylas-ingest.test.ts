/**
 * Integration tests for ingestNylasMessageFn.
 *
 * Calls the extracted logic function directly — no Inngest dev server needed.
 * Uses _setTestNylasClient to inject a mock Nylas getMessage call.
 *
 * Covers:
 *   1. Happy path: upserts thread + inserts message
 *   2. Candidate match: from_address found in candidates.emails
 *   3. Idempotency: replaying the same nylas_message_id → skipped (DO NOTHING)
 *   4. Outbound skip: from_address === account email_address → skipped
 *   5. RLS: workspace A cannot read workspace B's email_messages via scoped query
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { createTestTenant, cleanTestData, pool } from "../helpers/db";
import { ingestNylasMessageFn } from "../../artifacts/api-server/src/lib/email/ingest-nylas-message";
import {
  _setTestNylasClient,
  type NylasClientInterface,
} from "../../artifacts/api-server/src/lib/email/nylas";

const PREFIX = "nylas-ingest-test";

type Tenant = { orgId: string; workspaceId: string; userId: string };
let tenantA: Tenant;
let tenantB: Tenant;

const grantIdA = `grant-test-a-${Date.now()}`;
const grantIdB = `grant-test-b-${Date.now()}`;
const recruiterEmail = "recruiter@company-a.example.com";
const candidateEmail = "alice@candidate.example.com";

function makeMockMessage(overrides: {
  id?: string;
  threadId?: string;
  fromEmail?: string;
  subject?: string;
  date?: number;
} = {}): ReturnType<NylasClientInterface["getMessage"]> {
  return Promise.resolve({
    id: overrides.id ?? `msg-${randomUUID()}`,
    threadId: overrides.threadId ?? `thr-${randomUUID()}`,
    subject: overrides.subject ?? "Test subject",
    snippet: "Test snippet text",
    body: "<p>Test body</p>",
    from: [{ email: overrides.fromEmail ?? candidateEmail, name: "Alice" }],
    to: [{ email: recruiterEmail, name: "Recruiter" }],
    date: overrides.date ?? Math.floor(Date.now() / 1000) - 60,
  });
}

function installMockClient(opts: {
  id?: string;
  threadId?: string;
  fromEmail?: string;
  subject?: string;
} = {}) {
  const mock: NylasClientInterface = {
    createAuthUrl: () => "https://example.com",
    exchangeCode: async () => ({ grantId: "g", email: "e", provider: "google" }),
    getMessage: (_grantId, messageId) =>
      makeMockMessage({ id: messageId, ...opts }),
    revokeGrant: async () => undefined,
    sendMessage: async () => ({ nylasMessageId: "nylas_sent_noop", sentAt: new Date() }),
  };
  _setTestNylasClient(mock);
}

async function insertConnectedAccount(
  workspaceId: string,
  userId: string,
  grantId: string,
  email: string,
) {
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

async function insertCandidate(workspaceId: string, email: string): Promise<string> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO candidates (workspace_id, name, emails)
       VALUES ($1, $2, ARRAY[$3]::text[])
       RETURNING id`,
      [workspaceId, "Alice Candidate", email],
    );
    return res.rows[0].id as string;
  } finally {
    client.release();
  }
}

async function queryEmailThreads(workspaceId: string) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT * FROM email_threads WHERE workspace_id = $1`,
      [workspaceId],
    );
    return res.rows;
  } finally {
    client.release();
  }
}

async function queryEmailMessages(workspaceId: string) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT * FROM email_messages WHERE workspace_id = $1`,
      [workspaceId],
    );
    return res.rows;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  tenantA = await createTestTenant(PREFIX, "A", { emailV1Enabled: true });
  tenantB = await createTestTenant(PREFIX, "B", { emailV1Enabled: true });

  await insertConnectedAccount(tenantA.workspaceId, tenantA.userId, grantIdA, recruiterEmail);
  await insertConnectedAccount(tenantB.workspaceId, tenantB.userId, grantIdB, "recruiter-b@company-b.example.com");
});

afterAll(async () => {
  _setTestNylasClient(null);
  await cleanTestData(PREFIX);
});

afterEach(() => {
  _setTestNylasClient(null);
});

describe("ingestNylasMessageFn — happy path", () => {
  it("upserts email_thread and inserts email_message", async () => {
    const messageId = `msg-hp-${randomUUID()}`;
    const threadId = `thr-hp-${randomUUID()}`;

    installMockClient({ id: messageId, threadId, fromEmail: candidateEmail });

    const result = await ingestNylasMessageFn({ grantId: grantIdA, messageId, threadId });

    expect(result.skipped).toBe(false);
    expect(result.emailThreadId).toBeTruthy();
    expect(result.emailMessageId).toBeTruthy();

    const threads = await queryEmailThreads(tenantA.workspaceId);
    const thread = threads.find((t) => (t as { nylas_thread_id: string }).nylas_thread_id === threadId);
    expect(thread).toBeTruthy();
    expect((thread as { message_count: number }).message_count).toBeGreaterThanOrEqual(1);

    const messages = await queryEmailMessages(tenantA.workspaceId);
    const msg = messages.find((m) => (m as { nylas_message_id: string }).nylas_message_id === messageId);
    expect(msg).toBeTruthy();
    expect((msg as { direction: string }).direction).toBe("inbound");
    expect((msg as { status: string }).status).toBe("received");
  });
});

describe("ingestNylasMessageFn — candidate matching", () => {
  it("links message to candidate when from_address is in candidates.emails", async () => {
    const candidateId = await insertCandidate(tenantA.workspaceId, candidateEmail);
    const messageId = `msg-match-${randomUUID()}`;
    const threadId = `thr-match-${randomUUID()}`;

    installMockClient({ id: messageId, threadId, fromEmail: candidateEmail });

    const result = await ingestNylasMessageFn({ grantId: grantIdA, messageId, threadId });
    expect(result.skipped).toBe(false);

    const threads = await queryEmailThreads(tenantA.workspaceId);
    const thread = threads.find((t) => (t as { nylas_thread_id: string }).nylas_thread_id === threadId);
    expect(thread).toBeTruthy();
    expect((thread as { candidate_id: string }).candidate_id).toBe(candidateId);
  });
});

describe("ingestNylasMessageFn — idempotency", () => {
  it("does not double-insert when same nylas_message_id is replayed", async () => {
    const messageId = `msg-idem-${randomUUID()}`;
    const threadId = `thr-idem-${randomUUID()}`;

    installMockClient({ id: messageId, threadId, fromEmail: candidateEmail });

    const first = await ingestNylasMessageFn({ grantId: grantIdA, messageId, threadId });
    expect(first.skipped).toBe(false);

    installMockClient({ id: messageId, threadId, fromEmail: candidateEmail });
    const second = await ingestNylasMessageFn({ grantId: grantIdA, messageId, threadId });
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("duplicate");

    const messages = await queryEmailMessages(tenantA.workspaceId);
    const dups = messages.filter(
      (m) => (m as { nylas_message_id: string }).nylas_message_id === messageId,
    );
    expect(dups.length).toBe(1);
  });
});

describe("ingestNylasMessageFn — outbound skip", () => {
  it("skips messages where from_address matches the connected account email", async () => {
    const messageId = `msg-out-${randomUUID()}`;
    const threadId = `thr-out-${randomUUID()}`;

    // from_address === recruiterEmail (the connected account) → outbound
    installMockClient({ id: messageId, threadId, fromEmail: recruiterEmail });

    const result = await ingestNylasMessageFn({ grantId: grantIdA, messageId, threadId });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("outbound");
  });
});

describe("ingestNylasMessageFn — RLS isolation", () => {
  it("workspace B cannot see workspace A's ingested messages", async () => {
    const messageId = `msg-rls-${randomUUID()}`;
    const threadId = `thr-rls-${randomUUID()}`;

    installMockClient({ id: messageId, threadId, fromEmail: candidateEmail });

    const result = await ingestNylasMessageFn({ grantId: grantIdA, messageId, threadId });
    expect(result.skipped).toBe(false);

    // Query workspace B's messages — should be empty or not contain workspace A's data
    const bMessages = await queryEmailMessages(tenantB.workspaceId);
    const found = bMessages.find(
      (m) => (m as { nylas_message_id: string }).nylas_message_id === messageId,
    );
    expect(found).toBeUndefined();
  });
});
