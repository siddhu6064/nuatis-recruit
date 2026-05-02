/**
 * Invite Flow Smoke Test — tests/invite/invite-flow.test.ts
 *
 * Programmatically exercises the invite flow end-to-end using the real DB
 * (no browser, no HTTP) by calling the same helper functions used by the API routes.
 *
 * Flow:
 *   1. Create workspace + owner (via createTestTenant)
 *   2. Generate an invite token for a second email (via getInviteToken from packages/auth)
 *   3. Simulate token acceptance (via acceptInvite from packages/auth)
 *   4. Assert the second user exists in the workspace with role=recruiter
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, createTestTenant, cleanTestData } from "../helpers/db";

const PREFIX = "inviteflow";

// Dynamic import so the ESM workspace package resolves correctly at runtime
const { getInviteToken, acceptInvite } = await import("@workspace/auth");

type TenantResult = { orgId: string; workspaceId: string; userId: string };
let tenant: TenantResult;

beforeAll(async () => {
  await cleanTestData(PREFIX);
  tenant = await createTestTenant(PREFIX, "host");
});

afterAll(async () => {
  await cleanTestData(PREFIX);
});

describe("Invite flow: end-to-end smoke test", () => {
  it("creates an invite token stored in the DB", async () => {
    const email = `${PREFIX}+guest@test.invalid`;
    const token = await getInviteToken(tenant.workspaceId, email);

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(16);

    // Verify it landed in the DB
    const client = await pool.connect();
    try {
      const res = await client.query(
        "SELECT * FROM invites WHERE token = $1",
        [token],
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].workspace_id).toBe(tenant.workspaceId);
      expect(res.rows[0].email).toBe(email);
      expect(res.rows[0].used_at).toBeNull();
    } finally {
      client.release();
    }
  });

  it("acceptInvite adds the invited user to the workspace with recruiter role and marks token used", async () => {
    const guestEmail = `${PREFIX}+accept@test.invalid`;
    const guestExtId = `ext-${PREFIX}-accept`;

    // Step 1: generate token
    const token = await getInviteToken(tenant.workspaceId, guestEmail);

    // Step 2: accept it (simulates what the POST /workspace/invites/accept route does)
    const result = await acceptInvite(token, guestExtId, guestEmail, "Test Guest");

    expect(result).not.toBeNull();
    expect(result!.workspaceId).toBe(tenant.workspaceId);
    expect(result!.role).toBe("recruiter");

    // Step 3: verify user exists in DB
    const client = await pool.connect();
    try {
      const userRes = await client.query(
        "SELECT * FROM users WHERE external_auth_id = $1",
        [guestExtId],
      );
      expect(userRes.rows).toHaveLength(1);
      expect(userRes.rows[0].workspace_id).toBe(tenant.workspaceId);
      expect(userRes.rows[0].role).toBe("recruiter");
      expect(userRes.rows[0].email).toBe(guestEmail);

      // Step 4: verify token is marked used
      const inviteRes = await client.query(
        "SELECT * FROM invites WHERE token = $1",
        [token],
      );
      expect(inviteRes.rows).toHaveLength(1);
      expect(inviteRes.rows[0].used_at).not.toBeNull();
    } finally {
      client.release();
    }
  });

  it("acceptInvite rejects an already-used token", async () => {
    const guestEmail = `${PREFIX}+reuse@test.invalid`;
    const token = await getInviteToken(tenant.workspaceId, guestEmail);

    // Accept once
    await acceptInvite(token, `ext-${PREFIX}-reuse-1`, guestEmail, null);
    // Accept again with a different external ID — should return null
    const second = await acceptInvite(token, `ext-${PREFIX}-reuse-2`, guestEmail, null);

    expect(second).toBeNull();
  });

  it("acceptInvite rejects a token for a non-existent/expired invite", async () => {
    const result = await acceptInvite("non-existent-token-xyz", "ext-nobody", "nobody@test.invalid", null);
    expect(result).toBeNull();
  });
});
