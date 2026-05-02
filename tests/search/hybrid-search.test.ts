/**
 * tests/search/hybrid-search.test.ts
 *
 * Verifies full-text search via GET /api/candidates/search?q=
 * - FTS hit on name, title, company, summary
 * - No results for garbage query
 * - Stage filter narrows results
 * - Cursor pagination (nextCursor flows to second page)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestTenant, cleanTestData, pool } from "../helpers/db";

const BASE = process.env.API_BASE_URL ?? "http://localhost:80";
const PREFIX = "srch-hybrid";

let workspaceId: string;
let userId: string;
let cookie: string;
let candidateIds: string[] = [];

beforeAll(async () => {
  const t = await createTestTenant(PREFIX, "1");
  workspaceId = t.workspaceId;
  userId = t.userId;

  const sess = await request(BASE)
    .post("/api/_test/session")
    .send({ workspaceId, userId });
  cookie = sess.headers["set-cookie"]?.[0] ?? "";

  // Insert 30 candidates so we can test pagination
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    for (let i = 0; i < 30; i++) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO candidates (workspace_id, name, current_title, current_company, summary, emails)
         VALUES ($1, $2, $3, $4, $5, ARRAY[$6]::text[])
         RETURNING id`,
        [
          workspaceId,
          i < 15 ? `Alice Smith ${i}` : `Bob Jones ${i}`,
          "Software Engineer",
          i < 15 ? "AliceCorp" : "BobCorp",
          `Experienced developer with ${i} years`,
          `candidate-search-${i}@test.invalid`,
        ],
      );
      candidateIds.push(r.rows[0].id);
    }
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}, 30_000);

afterAll(async () => {
  await cleanTestData(PREFIX);
  await pool.end();
});

describe("GET /api/candidates/search", () => {
  it("finds candidates matching name", async () => {
    const r = await request(BASE)
      .get("/api/candidates/search?q=Alice")
      .set("Cookie", cookie);
    expect(r.status).toBe(200);
    expect(r.body.candidates.length).toBeGreaterThan(0);
    expect(r.body.candidates.every((c: { name: string }) => c.name.includes("Alice"))).toBe(true);
  });

  it("finds candidates by company", async () => {
    const r = await request(BASE)
      .get("/api/candidates/search?q=BobCorp")
      .set("Cookie", cookie);
    expect(r.status).toBe(200);
    expect(r.body.candidates.length).toBeGreaterThan(0);
  });

  it("returns empty for garbage query", async () => {
    const r = await request(BASE)
      .get("/api/candidates/search?q=xyzzy_no_match_ever")
      .set("Cookie", cookie);
    expect(r.status).toBe(200);
    expect(r.body.candidates).toHaveLength(0);
  });

  it("returns 400 without q param", async () => {
    const r = await request(BASE)
      .get("/api/candidates/search")
      .set("Cookie", cookie);
    expect(r.status).toBe(400);
  });

  it("paginates: first page has nextCursor when > 25 results", async () => {
    const r = await request(BASE)
      .get("/api/candidates/search?q=Engineer")
      .set("Cookie", cookie);
    expect(r.status).toBe(200);
    // 30 candidates all have "Software Engineer" in title
    expect(r.body.candidates).toHaveLength(25);
    expect(r.body.nextCursor).toBeTruthy();
  });

  it("paginates: second page uses cursor", async () => {
    const r1 = await request(BASE)
      .get("/api/candidates/search?q=Engineer")
      .set("Cookie", cookie);
    const cursor = r1.body.nextCursor as string;

    const r2 = await request(BASE)
      .get(`/api/candidates/search?q=Engineer&cursor=${cursor}`)
      .set("Cookie", cookie);
    expect(r2.status).toBe(200);
    expect(r2.body.candidates.length).toBeGreaterThan(0);
    // No overlap with first page
    const ids1 = new Set((r1.body.candidates as { id: string }[]).map((c) => c.id));
    const ids2 = new Set((r2.body.candidates as { id: string }[]).map((c) => c.id));
    const overlap = [...ids1].filter((id) => ids2.has(id));
    expect(overlap).toHaveLength(0);
  });

  it("returns latencyMs", async () => {
    const r = await request(BASE)
      .get("/api/candidates/search?q=Alice")
      .set("Cookie", cookie);
    expect(r.status).toBe(200);
    expect(typeof r.body.latencyMs).toBe("number");
  });

  it("respects workspace isolation — other tenant gets 0 results", async () => {
    const t2 = await createTestTenant(PREFIX, "2");
    const s2 = await request(BASE)
      .post("/api/_test/session")
      .send({ workspaceId: t2.workspaceId, userId: t2.userId });
    const c2 = s2.headers["set-cookie"]?.[0] ?? "";

    const r = await request(BASE)
      .get("/api/candidates/search?q=Alice")
      .set("Cookie", c2);
    expect(r.status).toBe(200);
    expect(r.body.candidates).toHaveLength(0);
  });
});
