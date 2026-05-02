/**
 * RLS Isolation Test — tests/security/rls.test.ts
 *
 * Tests that cross-workspace data isolation holds.
 * NOTE: PostgreSQL RLS (rowsecurity) is NOT currently enabled on any table
 * (verified: rowsecurity=false, pg_policies=[] for all tables in the public schema).
 * These tests use SET LOCAL app.current_workspace_id inside a transaction to
 * simulate what RLS would enforce. They are expected to FAIL until RLS policies
 * are created, documenting the gap as a required follow-up.
 *
 * Required before Batch 2: enable RLS + create policies per workspace_id column.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import pg from "pg";
import { pool, createTestTenant, cleanTestData, teardown } from "../helpers/db";

const PREFIX = "rlstest";

type TenantResult = { orgId: string; workspaceId: string; userId: string };

let tenantA: TenantResult;
let tenantB: TenantResult;

beforeAll(async () => {
  await cleanTestData(PREFIX);
  tenantA = await createTestTenant(PREFIX, "a");
  tenantB = await createTestTenant(PREFIX, "b");
});

afterAll(async () => {
  await cleanTestData(PREFIX);
});

describe("RLS: cross-workspace isolation on `users` table", () => {
  it("user A cannot read workspace B users when app.current_workspace_id is bound to workspace A", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Bind the session to workspace A
      await client.query(
        "SELECT set_config('app.current_workspace_id', $1, true)",
        [tenantA.workspaceId],
      );

      // Attempt to read workspace B users — RLS should return nothing
      const res = await client.query(
        "SELECT * FROM users WHERE workspace_id = $1",
        [tenantB.workspaceId],
      );

      await client.query("ROLLBACK");

      // This assertion will FAIL until RLS policies are in place.
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

      // Own workspace should still be readable under RLS
      expect(res.rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      client.release();
    }
  });
});

describe("RLS: cross-workspace isolation on `audit_logs` table", () => {
  it("workspace A session cannot read audit_logs belonging to workspace B", async () => {
    // Insert an audit_log row for workspace B
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

      // Expect empty — will FAIL until RLS policies exist
      expect(res.rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });
});
