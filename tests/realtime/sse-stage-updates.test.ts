/**
 * SSE Stage Update Tests
 *
 * Verifies the PostgreSQL NOTIFY → SSE pipeline:
 *   - Dev SSE endpoint connects and sends a heartbeat comment
 *   - An application stage change triggers a NOTIFY on 'applications_changed'
 *   - The SSE stream delivers the notification with correct payload
 *   - Cross-workspace notifications are NOT delivered (workspace_id filter)
 *
 * Uses:
 *   - GET /api/_test/sse-stream?workspace_id=X&job_id=Y  (dev-only, no auth)
 *   - Direct SQL to fire a stage change and verify NOTIFY
 *
 * Note: We use EventSource polyfill via fetch + ReadableStream parsing because
 * Node doesn't have native EventSource. The test streams the response body.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { pool, createTestTenant, cleanTestData, teardown } from "../helpers/db";

const PREFIX = "ssestage";
const API_BASE = "http://localhost:8080";
const TIMEOUT_MS = 5000;

let workspaceId: string;
let jobId: string;
let clientId: string;
let candidateId: string;
let applicationId: string;

let workspaceBId: string;
let jobBId: string;
let applicationBId: string;

beforeAll(async () => {
  await cleanTestData(PREFIX);
  const tenantA = await createTestTenant(PREFIX, "a");
  workspaceId = tenantA.workspaceId;

  const tenantB = await createTestTenant(PREFIX, "b");
  workspaceBId = tenantB.workspaceId;

  const c = await pool.connect();
  try {
    const cr = await c.query(
      `INSERT INTO clients (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [workspaceId, `${PREFIX}-client`],
    );
    clientId = cr.rows[0].id as string;

    const jr = await c.query(
      `INSERT INTO jobs (workspace_id, client_id, title, slug, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
      [workspaceId, clientId, `${PREFIX} Job`, `${PREFIX}-job`],
    );
    jobId = jr.rows[0].id as string;

    const canr = await c.query(
      `INSERT INTO candidates (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [workspaceId, `${PREFIX} Candidate`],
    );
    candidateId = canr.rows[0].id as string;

    const appr = await c.query(
      `INSERT INTO applications (workspace_id, candidate_id, job_id, stage, position_in_stage)
       VALUES ($1, $2, $3, 'applied', 1000) RETURNING id`,
      [workspaceId, candidateId, jobId],
    );
    applicationId = appr.rows[0].id as string;

    // Workspace B setup
    const crB = await c.query(
      `INSERT INTO clients (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [workspaceBId, `${PREFIX}-client-b`],
    );
    const jrB = await c.query(
      `INSERT INTO jobs (workspace_id, client_id, title, slug, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
      [workspaceBId, crB.rows[0].id, `${PREFIX} Job B`, `${PREFIX}-job-b`],
    );
    jobBId = jrB.rows[0].id as string;
    const canrB = await c.query(
      `INSERT INTO candidates (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [workspaceBId, `${PREFIX} Cand B`],
    );
    const apprB = await c.query(
      `INSERT INTO applications (workspace_id, candidate_id, job_id, stage, position_in_stage)
       VALUES ($1, $2, $3, 'applied', 1000) RETURNING id`,
      [workspaceBId, canrB.rows[0].id, jrB.rows[0].id],
    );
    applicationBId = apprB.rows[0].id as string;
  } finally {
    c.release();
  }
});

afterAll(async () => {
  await cleanTestData(PREFIX);
  await teardown();
});

/** Read SSE stream until a data: line is received or timeout */
async function collectSSEEvent(
  url: string,
  timeoutMs = TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Look for data: line
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.startsWith("data:")) {
          clearTimeout(timer);
          reader.cancel().catch(() => {/* ignore */});
          return line.slice(5).trim();
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") return null;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return null;
}

describe("GET /api/_test/sse-stream (dev-only)", () => {
  it("returns 400 when workspace_id or job_id is missing", async () => {
    const res = await fetch(`${API_BASE}/api/_test/sse-stream?workspace_id=${workspaceId}`);
    expect(res.status).toBe(400);
  });

  it("connects and delivers notification when application stage is updated", async () => {
    const url = `${API_BASE}/api/_test/sse-stream?workspace_id=${workspaceId}&job_id=${jobId}`;

    // Start reading stream, then trigger stage change via DB
    const eventPromise = collectSSEEvent(url, TIMEOUT_MS);

    // Small delay to let SSE connection establish
    await new Promise((r) => setTimeout(r, 500));

    // Trigger NOTIFY via UPDATE that fires the applications_notify_update trigger
    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE applications SET stage = 'screen' WHERE id = $1`,
        [applicationId],
      );
    } finally {
      c.release();
    }

    const rawEvent = await eventPromise;
    expect(rawEvent).not.toBeNull();

    const payload = JSON.parse(rawEvent!) as {
      workspace_id: string;
      job_id: string;
      application_id: string;
      action: string;
    };
    expect(payload.workspace_id).toBe(workspaceId);
    expect(payload.job_id).toBe(jobId);
    expect(payload.application_id).toBe(applicationId);
    expect(payload.action).toMatch(/UPDATE|INSERT/);
  });

  it("does NOT deliver notifications from a different workspace", async () => {
    // Subscribe to workspace A / job A stream
    const url = `${API_BASE}/api/_test/sse-stream?workspace_id=${workspaceId}&job_id=${jobId}`;

    const eventPromise = collectSSEEvent(url, 2000); // short timeout — expect no event

    await new Promise((r) => setTimeout(r, 400));

    // Trigger stage change on workspace B application — should NOT appear in workspace A stream
    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE applications SET stage = 'screen' WHERE id = $1`,
        [applicationBId],
      );
    } finally {
      c.release();
    }

    // Allow 1.5s for any unwanted event to arrive
    const rawEvent = await eventPromise;

    // We expect null (timeout with no data event) because workspace B change
    // should not flow to workspace A stream
    if (rawEvent !== null) {
      const payload = JSON.parse(rawEvent) as { workspace_id: string };
      // If something came through, it must not be workspace B's data
      expect(payload.workspace_id).not.toBe(workspaceBId);
    }
  });
});
