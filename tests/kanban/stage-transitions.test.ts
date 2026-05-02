/**
 * Kanban Stage Transition Tests
 *
 * Verifies:
 *   - POST /api/applications/:id/move returns 200 with updated stage+position
 *   - activities row of type 'application.stage_change' is written
 *   - audit_logs row with action='application.stage_change' is written
 *   - positionInStage defaults correctly (end-of-stage placement)
 *   - Moving within same stage with explicit positionInStage works
 *   - 404 returned for unknown application id
 *   - Cross-workspace move attempt is blocked (404)
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { pool, createTestTenant, cleanTestData, teardown } from "../helpers/db";

const PREFIX = "kanbantrans";
const API_BASE = "http://localhost:8080";

let workspaceId: string;
let userId: string;
let jobId: string;
let clientId: string;
let candidateId: string;
let applicationId: string;

// Workspace B for cross-workspace isolation
let workspaceBId: string;
let applicationBId: string;

let sessionCookie = "";

async function createSession(wsId: string, uid: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/_test/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: wsId, userId: uid }),
  });
  if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0];
}

beforeAll(async () => {
  await cleanTestData(PREFIX);

  const tenantA = await createTestTenant(PREFIX, "a");
  workspaceId = tenantA.workspaceId;
  userId = tenantA.userId;

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

    // Workspace B candidate + application for cross-workspace test
    const canrB = await c.query(
      `INSERT INTO candidates (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [workspaceBId, `${PREFIX} Candidate B`],
    );
    const jobrB = await c.query(
      `INSERT INTO clients (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [workspaceBId, `${PREFIX}-client-b`],
    );
    const clientBId = jobrB.rows[0].id as string;
    const jrB = await c.query(
      `INSERT INTO jobs (workspace_id, client_id, title, slug, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
      [workspaceBId, clientBId, `${PREFIX} Job B`, `${PREFIX}-job-b`],
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

  sessionCookie = await createSession(workspaceId, userId);
});

afterAll(async () => {
  await cleanTestData(PREFIX);
  await teardown();
});

describe("POST /api/applications/:id/move", () => {
  it("moves application to a new stage and returns updated record", async () => {
    const res = await fetch(`${API_BASE}/api/applications/${applicationId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ stage: "screen" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; stage: string; positionInStage: number };
    expect(body.id).toBe(applicationId);
    expect(body.stage).toBe("screen");
    expect(body.positionInStage).toBeGreaterThan(0);
  });

  it("writes an activity row of type application.stage_change", async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT * FROM activities
         WHERE workspace_id = $1
           AND type = 'application.stage_change'
           AND payload->>'application_id' = $2
         ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, applicationId],
      );
      expect(r.rows.length).toBe(1);
      const payload = r.rows[0].payload as Record<string, string>;
      expect(payload.to_stage).toBe("screen");
      expect(payload.from_stage).toBe("applied");
    } finally {
      c.release();
    }
  });

  it("writes an audit_log row with action=application.stage_change", async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT * FROM audit_logs
         WHERE workspace_id = $1
           AND action = 'application.stage_change'
           AND target_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, applicationId],
      );
      expect(r.rows.length).toBe(1);
    } finally {
      c.release();
    }
  });

  it("places card at positionInStage 1000 when stage was empty", async () => {
    // application already moved to screen in test 1 — position should be 1000
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT position_in_stage FROM applications WHERE id = $1`,
        [applicationId],
      );
      expect(r.rows[0].position_in_stage).toBe(1000);
    } finally {
      c.release();
    }
  });

  it("moves within same stage when explicit positionInStage is provided", async () => {
    const res = await fetch(`${API_BASE}/api/applications/${applicationId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ stage: "screen", positionInStage: 500 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { positionInStage: number };
    expect(body.positionInStage).toBe(500);
  });

  it("returns 404 for unknown application id", async () => {
    const res = await fetch(
      `${API_BASE}/api/applications/00000000-0000-0000-0000-000000000000/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: sessionCookie },
        body: JSON.stringify({ stage: "screen" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when trying to move another workspace's application", async () => {
    const res = await fetch(`${API_BASE}/api/applications/${applicationBId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ stage: "screen" }),
    });
    // RLS hides workspace B's application — looks like 404 from workspace A's session
    expect(res.status).toBe(404);
  });

  it("returns 400 when stage is missing", async () => {
    const res = await fetch(`${API_BASE}/api/applications/${applicationId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
