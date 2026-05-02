/**
 * RLS Isolation Tests
 *
 * Verifies cross-workspace data isolation on all tenant-scoped tables.
 * Uses nuatis_app role (non-superuser) via the pool override in tests/helpers/db.ts
 * so that RLS policies are actually enforced.
 *
 * Pattern for each table:
 *   1. Insert a row belonging to workspace B (no context set — allowed).
 *   2. Open a transaction, SET app.current_workspace_id = workspace A.
 *   3. Query for workspace B's row — expect 0 results (RLS filters it out).
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { pool, createTestTenant, cleanTestData, teardown } from "../helpers/db";

const PREFIX = "rlstest";

type TenantResult = { orgId: string; workspaceId: string; userId: string };

let tenantA: TenantResult;
let tenantB: TenantResult;

// Shared IDs for Batch 2 table rows belonging to workspace B
let clientBId: string;
let jobBId: string;
let candidateBId: string;
let applicationBId: string;
let resumeBId: string;
let activityBId: string;

beforeAll(async () => {
  await cleanTestData(PREFIX);
  tenantA = await createTestTenant(PREFIX, "a");
  tenantB = await createTestTenant(PREFIX, "b");

  // Seed Batch 2 rows for workspace B (no RLS context set → INSERT allowed)
  const c = await pool.connect();
  try {
    // client
    const clientRes = await c.query(
      `INSERT INTO clients (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [tenantB.workspaceId, `${PREFIX}-client-b`],
    );
    clientBId = clientRes.rows[0].id as string;

    // job
    const jobRes = await c.query(
      `INSERT INTO jobs (workspace_id, client_id, title, slug, status)
       VALUES ($1, $2, $3, $4, 'draft') RETURNING id`,
      [tenantB.workspaceId, clientBId, `${PREFIX} Job B`, `${PREFIX}-job-b`],
    );
    jobBId = jobRes.rows[0].id as string;

    // candidate
    const candRes = await c.query(
      `INSERT INTO candidates (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [tenantB.workspaceId, `${PREFIX} Candidate B`],
    );
    candidateBId = candRes.rows[0].id as string;

    // application
    const appRes = await c.query(
      `INSERT INTO applications (workspace_id, candidate_id, job_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenantB.workspaceId, candidateBId, jobBId],
    );
    applicationBId = appRes.rows[0].id as string;

    // resume
    const resumeRes = await c.query(
      `INSERT INTO resumes (workspace_id, candidate_id, file_url)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenantB.workspaceId, candidateBId, "test://fake-resume.pdf"],
    );
    resumeBId = resumeRes.rows[0].id as string;

    // activity
    const actRes = await c.query(
      `INSERT INTO activities (workspace_id, candidate_id, type)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenantB.workspaceId, candidateBId, "test.activity"],
    );
    activityBId = actRes.rows[0].id as string;
  } finally {
    c.release();
  }
});

afterAll(async () => {
  // Clean up Batch 2 rows first (FK-safe order)
  const c = await pool.connect();
  try {
    if (activityBId) await c.query(`DELETE FROM activities WHERE id = $1`, [activityBId]);
    if (resumeBId) await c.query(`DELETE FROM resumes WHERE id = $1`, [resumeBId]);
    if (applicationBId) await c.query(`DELETE FROM applications WHERE id = $1`, [applicationBId]);
    if (candidateBId) await c.query(`DELETE FROM candidates WHERE id = $1`, [candidateBId]);
    if (jobBId) await c.query(`DELETE FROM jobs WHERE id = $1`, [jobBId]);
    if (clientBId) await c.query(`DELETE FROM clients WHERE id = $1`, [clientBId]);
  } finally {
    c.release();
  }
  await cleanTestData(PREFIX);
  await teardown();
});

// ── Helper ──────────────────────────────────────────────────────────────────

async function assertIsolated(table: string, idColumn: string, idValue: string, contextWorkspaceId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.current_workspace_id', $1, true)",
      [contextWorkspaceId],
    );
    const res = await client.query(
      `SELECT id FROM ${table} WHERE ${idColumn} = $1`,
      [idValue],
    );
    await client.query("ROLLBACK");
    return res.rows.length;
  } finally {
    client.release();
  }
}

// ── Batch 1 tables ──────────────────────────────────────────────────────────

describe("RLS: cross-workspace isolation on `users` table", () => {
  it("user A cannot read workspace B users when app.current_workspace_id is bound to workspace A", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.current_workspace_id', $1, true)",
        [tenantA.workspaceId],
      );
      const res = await client.query(
        "SELECT * FROM users WHERE workspace_id = $1",
        [tenantB.workspaceId],
      );
      await client.query("ROLLBACK");
      expect(res.rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });

  it("user A can read their own workspace users when app.current_workspace_id is bound", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.current_workspace_id', $1, true)",
        [tenantA.workspaceId],
      );
      const res = await client.query(
        "SELECT * FROM users WHERE workspace_id = $1",
        [tenantA.workspaceId],
      );
      await client.query("ROLLBACK");
      expect(res.rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      client.release();
    }
  });
});

describe("RLS: cross-workspace isolation on `audit_logs` table", () => {
  it("workspace A session cannot read audit_logs belonging to workspace B", async () => {
    const insertClient = await pool.connect();
    let auditLogId: string | null = null;
    try {
      const r = await insertClient.query(
        `INSERT INTO audit_logs (workspace_id, action, target_type, ip)
         VALUES ($1, 'test.action', 'test', $2)
         RETURNING id`,
        [tenantB.workspaceId, PREFIX],
      );
      auditLogId = r.rows[0].id;
    } finally {
      insertClient.release();
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.current_workspace_id', $1, true)",
        [tenantA.workspaceId],
      );
      const res = await client.query(
        "SELECT * FROM audit_logs WHERE workspace_id = $1",
        [tenantB.workspaceId],
      );
      await client.query("ROLLBACK");
      expect(res.rows).toHaveLength(0);
    } finally {
      client.release();
    }

    // cleanup
    if (auditLogId) {
      const c = await pool.connect();
      try { await c.query(`DELETE FROM audit_logs WHERE id = $1`, [auditLogId]); }
      finally { c.release(); }
    }
  });
});

// ── Batch 2 tables ──────────────────────────────────────────────────────────

describe("RLS: cross-workspace isolation on `clients` table", () => {
  it("workspace A cannot read clients belonging to workspace B", async () => {
    const count = await assertIsolated("clients", "id", clientBId, tenantA.workspaceId);
    expect(count).toBe(0);
  });
});

describe("RLS: cross-workspace isolation on `jobs` table", () => {
  it("workspace A cannot read jobs belonging to workspace B", async () => {
    const count = await assertIsolated("jobs", "id", jobBId, tenantA.workspaceId);
    expect(count).toBe(0);
  });
});

describe("RLS: cross-workspace isolation on `candidates` table", () => {
  it("workspace A cannot read candidates belonging to workspace B", async () => {
    const count = await assertIsolated("candidates", "id", candidateBId, tenantA.workspaceId);
    expect(count).toBe(0);
  });
});

describe("RLS: cross-workspace isolation on `applications` table", () => {
  it("workspace A cannot read applications belonging to workspace B", async () => {
    const count = await assertIsolated("applications", "id", applicationBId, tenantA.workspaceId);
    expect(count).toBe(0);
  });
});

describe("RLS: cross-workspace isolation on `resumes` table", () => {
  it("workspace A cannot read resumes belonging to workspace B", async () => {
    const count = await assertIsolated("resumes", "id", resumeBId, tenantA.workspaceId);
    expect(count).toBe(0);
  });
});

describe("RLS: cross-workspace isolation on `activities` table", () => {
  it("workspace A cannot read activities belonging to workspace B", async () => {
    const count = await assertIsolated("activities", "id", activityBId, tenantA.workspaceId);
    expect(count).toBe(0);
  });
});
