/**
 * Audit Log Test — tests/audit/audit-log.test.ts
 *
 * Verifies that audit_logs rows are written with correct fields on key events.
 *
 * NOTE: The current codebase does NOT write audit_log rows automatically via
 * Drizzle hooks or middleware. The audit_logs table exists but no code path
 * currently inserts into it. These tests document that gap — they will FAIL
 * until audit-log writes are added to the relevant service layer functions.
 *
 * Required before Batch 2: add audit_log writes in the API routes for:
 *   workspace creation, user invite, role change, user deactivation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, createTestTenant, cleanTestData } from "../helpers/db";

const PREFIX = "auditlog";

type TenantResult = { orgId: string; workspaceId: string; userId: string };
let tenant: TenantResult;

beforeAll(async () => {
  await cleanTestData(PREFIX);
  tenant = await createTestTenant(PREFIX, "main");
});

afterAll(async () => {
  await cleanTestData(PREFIX);
});

async function getAuditLogs(
  workspaceId: string,
  action: string,
): Promise<Array<Record<string, unknown>>> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 10",
      [workspaceId, action],
    );
    return res.rows;
  } finally {
    client.release();
  }
}

describe("Audit log: workspace creation", () => {
  it("writes an audit_log row with action=workspace.create when a workspace is created", async () => {
    // The createTestTenant helper directly inserts via SQL — it bypasses application
    // logic. In production, the upsertNuatisUser function in auth.ts creates the
    // workspace inside a transaction but does NOT write an audit_log row.
    // We verify this gap here.
    const logs = await getAuditLogs(tenant.workspaceId, "workspace.create");

    // EXPECTED TO FAIL: no audit log is written today
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]).toMatchObject({
      workspace_id: tenant.workspaceId,
      action: "workspace.create",
    });
  });
});

describe("Audit log: user invite", () => {
  it("writes an audit_log row with action=invite.create when an invite is created", async () => {
    // Simulate an invite creation directly in DB
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO invites (workspace_id, email, token, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
        [tenant.workspaceId, `${PREFIX}+invited@test.invalid`, `tok-${PREFIX}-invite`],
      );
    } finally {
      client.release();
    }

    // The API route POST /workspace/invites does NOT write an audit_log row today.
    const logs = await getAuditLogs(tenant.workspaceId, "invite.create");

    // EXPECTED TO FAIL: no audit log is written today
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]).toMatchObject({
      workspace_id: tenant.workspaceId,
      action: "invite.create",
    });
  });
});

describe("Audit log: role change", () => {
  it("writes an audit_log row with action=member.role_change and diff_json when role is updated", async () => {
    // Simulate a role update directly in DB
    const client = await pool.connect();
    try {
      await client.query(
        "UPDATE users SET role = 'recruiter' WHERE id = $1",
        [tenant.userId],
      );
    } finally {
      client.release();
    }

    // The API route PATCH /workspace/members/:id/role does NOT write an audit_log row today.
    const logs = await getAuditLogs(tenant.workspaceId, "member.role_change");

    // EXPECTED TO FAIL: no audit log is written today
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]).toMatchObject({
      workspace_id: tenant.workspaceId,
      action: "member.role_change",
    });
    expect(logs[0].diff_json).toBeDefined();
  });
});

describe("Audit log: user deactivation / removal", () => {
  it("writes an audit_log row with action=member.removed when a user is deleted", async () => {
    // Insert a second user to remove
    const client = await pool.connect();
    let userId2: string | null = null;
    try {
      const r = await client.query(
        `INSERT INTO users (workspace_id, external_auth_id, external_auth_provider, email, role)
         VALUES ($1, $2, 'test', $3, 'recruiter')
         RETURNING id`,
        [tenant.workspaceId, `ext-${PREFIX}-remove`, `${PREFIX}+remove@test.invalid`],
      );
      userId2 = r.rows[0].id;
      // Delete them (simulating the API DELETE /workspace/members/:id)
      await client.query("DELETE FROM users WHERE id = $1", [userId2]);
    } finally {
      client.release();
    }

    // The DELETE route does NOT write an audit_log row today.
    const logs = await getAuditLogs(tenant.workspaceId, "member.removed");

    // EXPECTED TO FAIL: no audit log is written today
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]).toMatchObject({
      workspace_id: tenant.workspaceId,
      action: "member.removed",
    });
  });
});
