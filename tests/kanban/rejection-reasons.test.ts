/**
 * Rejection Reasons Tests
 *
 * Verifies:
 *   - GET /api/rejection-reasons returns workspace's reasons
 *   - 7 defaults are seeded when workspace is created
 *   - RLS: workspace A cannot see workspace B's rejection reasons
 *   - Results are ordered by sort_order ascending
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { pool, createTestTenant, cleanTestData, teardown } from "../helpers/db";

const PREFIX = "rjreasons";
const API_BASE = "http://localhost:8080";

let workspaceId: string;
let userId: string;
let workspaceBId: string;

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

  sessionCookie = await createSession(workspaceId, userId);
});

afterAll(async () => {
  await cleanTestData(PREFIX);
  await teardown();
});

describe("GET /api/rejection-reasons", () => {
  it("returns 200 with rejectionReasons array", async () => {
    const res = await fetch(`${API_BASE}/api/rejection-reasons`, {
      headers: { Cookie: sessionCookie },
      credentials: "include",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { rejectionReasons: unknown[] };
    expect(Array.isArray(body.rejectionReasons)).toBe(true);
  });

  it("returns exactly 7 default seeded reasons for a new workspace", async () => {
    const res = await fetch(`${API_BASE}/api/rejection-reasons`, {
      headers: { Cookie: sessionCookie },
    });
    const body = await res.json() as { rejectionReasons: unknown[] };
    expect(body.rejectionReasons.length).toBe(7);
  });

  it("reasons are ordered by sort_order ascending", async () => {
    const res = await fetch(`${API_BASE}/api/rejection-reasons`, {
      headers: { Cookie: sessionCookie },
    });
    const body = await res.json() as { rejectionReasons: { sortOrder: number }[] };
    const orders = body.rejectionReasons.map((r) => r.sortOrder ?? 0);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThanOrEqual(orders[i - 1]);
    }
  });

  it("RLS: workspace A session only sees workspace A rejection reasons", async () => {
    const c = await pool.connect();
    try {
      // Count workspace B's reasons directly
      const rB = await c.query(
        `SELECT COUNT(*) FROM rejection_reasons WHERE workspace_id = $1`,
        [workspaceBId],
      );
      expect(Number(rB.rows[0].count)).toBe(7);

      // Via API (workspace A session) — should only see workspace A's reasons
      const res = await fetch(`${API_BASE}/api/rejection-reasons`, {
        headers: { Cookie: sessionCookie },
      });
      const body = await res.json() as { rejectionReasons: { workspaceId?: string }[] };
      for (const r of body.rejectionReasons) {
        if (r.workspaceId) expect(r.workspaceId).toBe(workspaceId);
      }
    } finally {
      c.release();
    }
  });

  it("DB trigger seeds 7 rejection reasons on workspace INSERT", async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT COUNT(*) FROM rejection_reasons WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(Number(r.rows[0].count)).toBe(7);
    } finally {
      c.release();
    }
  });

  it("returns 401 for unauthenticated request", async () => {
    const res = await fetch(`${API_BASE}/api/rejection-reasons`);
    expect([401, 302]).toContain(res.status);
  });
});
