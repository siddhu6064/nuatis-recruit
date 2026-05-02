/**
 * Kanban Bulk Operations Tests
 *
 * Verifies:
 *   - POST /api/applications/bulk-move moves multiple apps + writes activities
 *   - POST /api/applications/bulk-reject sets stage='rejected' + writes activities
 *   - Bulk move returns count + stage
 *   - Bulk reject with rejectionReasonId records it in activity payload
 *   - Cross-workspace: can't bulk-move another workspace's apps (400 partial/mismatch)
 *   - Empty applicationIds array returns 400
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { pool, createTestTenant, cleanTestData, teardown } from "../helpers/db";

const PREFIX = "kanbanbulk";
const API_BASE = "http://localhost:8080";

let workspaceId: string;
let userId: string;
let jobId: string;
let clientId: string;
let candidateIds: string[] = [];
let applicationIds: string[] = [];

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
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
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

    // Create 3 candidates + applications
    for (let i = 0; i < 3; i++) {
      const canr = await c.query(
        `INSERT INTO candidates (workspace_id, name) VALUES ($1, $2) RETURNING id`,
        [workspaceId, `${PREFIX} Candidate ${i}`],
      );
      candidateIds.push(canr.rows[0].id as string);

      const appr = await c.query(
        `INSERT INTO applications (workspace_id, candidate_id, job_id, stage, position_in_stage)
         VALUES ($1, $2, $3, 'applied', ${(i + 1) * 1000}) RETURNING id`,
        [workspaceId, canr.rows[0].id, jobId],
      );
      applicationIds.push(appr.rows[0].id as string);
    }

    // Workspace B application for cross-workspace test
    const canrB = await c.query(
      `INSERT INTO candidates (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [workspaceBId, `${PREFIX} Cand B`],
    );
    const crB = await c.query(
      `INSERT INTO clients (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [workspaceBId, `${PREFIX}-client-b`],
    );
    const jrB = await c.query(
      `INSERT INTO jobs (workspace_id, client_id, title, slug, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
      [workspaceBId, crB.rows[0].id, `${PREFIX} Job B`, `${PREFIX}-job-b`],
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

describe("POST /api/applications/bulk-move", () => {
  it("moves all specified applications to target stage", async () => {
    const res = await fetch(`${API_BASE}/api/applications/bulk-move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ applicationIds, stage: "screen" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { moved: number; stage: string };
    expect(body.moved).toBe(3);
    expect(body.stage).toBe("screen");
  });

  it("all applications now have stage=screen in DB", async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT COUNT(*) FROM applications WHERE workspace_id = $1 AND stage = 'screen'`,
        [workspaceId],
      );
      expect(Number(r.rows[0].count)).toBe(3);
    } finally {
      c.release();
    }
  });

  it("writes 3 activity rows of type application.stage_change", async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT COUNT(*) FROM activities
         WHERE workspace_id = $1 AND type = 'application.stage_change'
         AND payload->>'to_stage' = 'screen' AND (payload->>'bulk')::boolean = true`,
        [workspaceId],
      );
      expect(Number(r.rows[0].count)).toBeGreaterThanOrEqual(3);
    } finally {
      c.release();
    }
  });

  it("returns 400 when applicationIds is empty", async () => {
    const res = await fetch(`${API_BASE}/api/applications/bulk-move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ applicationIds: [], stage: "screen" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when mixing cross-workspace IDs", async () => {
    const res = await fetch(`${API_BASE}/api/applications/bulk-move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ applicationIds: [applicationIds[0], applicationBId], stage: "screen" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/applications/bulk-reject", () => {
  it("rejects all specified applications (moves to rejected stage)", async () => {
    const res = await fetch(`${API_BASE}/api/applications/bulk-reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ applicationIds }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { rejected: number };
    expect(body.rejected).toBe(3);
  });

  it("all rejected applications have stage=rejected in DB", async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT COUNT(*) FROM applications
         WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND stage = 'rejected'`,
        [workspaceId, applicationIds],
      );
      expect(Number(r.rows[0].count)).toBe(3);
    } finally {
      c.release();
    }
  });

  it("records rejection_reason_id in activity payload when provided", async () => {
    // Insert fresh candidate + application using separate connections (auto-commit)
    let freshAppId: string;
    let reasonId: string | undefined;

    {
      const c = await pool.connect();
      try {
        const canr = await c.query(
          `INSERT INTO candidates (workspace_id, name) VALUES ($1, $2) RETURNING id`,
          [workspaceId, `${PREFIX} RejCandidate`],
        );
        const appr = await c.query(
          `INSERT INTO applications (workspace_id, candidate_id, job_id, stage, position_in_stage)
           VALUES ($1, $2, $3, 'applied', 9000) RETURNING id`,
          [workspaceId, canr.rows[0].id, jobId],
        );
        freshAppId = appr.rows[0].id as string;
      } finally {
        c.release();
      }
    }

    {
      const c = await pool.connect();
      try {
        const rr = await c.query(
          `SELECT id FROM rejection_reasons WHERE workspace_id = $1 LIMIT 1`,
          [workspaceId],
        );
        reasonId = rr.rows[0]?.id as string | undefined;
      } finally {
        c.release();
      }
    }

    if (!reasonId) return; // skip if no default reasons seeded (shouldn't happen)

    const res = await fetch(`${API_BASE}/api/applications/bulk-reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ applicationIds: [freshAppId!], rejectionReasonId: reasonId }),
    });
    expect(res.status).toBe(200);

    // Wait briefly for the rlsMiddleware transaction to commit after response
    await new Promise((r) => setTimeout(r, 80));

    const c = await pool.connect();
    try {
      const act = await c.query(
        `SELECT payload FROM activities
         WHERE workspace_id = $1 AND type = 'application.stage_change'
           AND payload->>'application_id' = $2
           AND payload->>'to_stage' = 'rejected'
         ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, freshAppId!],
      );
      expect(act.rows.length).toBe(1);
      const payload = act.rows[0].payload as Record<string, string>;
      expect(payload.rejection_reason_id).toBe(reasonId);
    } finally {
      c.release();
    }
  });

  it("returns 400 when applicationIds is empty", async () => {
    const res = await fetch(`${API_BASE}/api/applications/bulk-reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ applicationIds: [] }),
    });
    expect(res.status).toBe(400);
  });
});
