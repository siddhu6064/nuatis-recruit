/**
 * tests/search/perf.test.ts
 *
 * Verifies P50 search latency < 200ms across 20 queries.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestTenant, cleanTestData, pool } from "../helpers/db";

const BASE = process.env.API_BASE_URL ?? "http://localhost:80";
const PREFIX = "srch-perf";

let workspaceId: string;
let userId: string;
let cookie: string;

beforeAll(async () => {
  const t = await createTestTenant(PREFIX, "1");
  workspaceId = t.workspaceId;
  userId = t.userId;

  const sess = await request(BASE)
    .post("/api/_test/session")
    .send({ workspaceId, userId });
  cookie = sess.headers["set-cookie"]?.[0] ?? "";

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    for (let i = 0; i < 50; i++) {
      await c.query(
        `INSERT INTO candidates (workspace_id, name, current_title, current_company, summary, emails)
         VALUES ($1, $2, $3, $4, $5, ARRAY[$6]::text[])`,
        [
          workspaceId,
          `Perf Candidate ${i}`,
          "Senior Engineer",
          `TechCo ${i % 5}`,
          `Background in distributed systems and cloud infrastructure at level ${i}`,
          `perf-${i}@test.invalid`,
        ],
      );
    }
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}, 30_000);

afterAll(async () => {
  await cleanTestData(PREFIX);
});

describe("Search performance", () => {
  it("P50 latency < 200ms across 20 queries", async () => {
    const queries = ["Senior", "Engineer", "TechCo", "distributed", "cloud", "infrastructure",
      "Perf Candidate", "systems", "level", "background",
      "Senior Engineer", "TechCo 0", "TechCo 1", "TechCo 2",
      "distributed systems", "cloud infrastructure", "perf", "candidate",
      "Senior Engineer TechCo", "background distributed"];

    const latencies: number[] = [];
    for (const q of queries) {
      const start = Date.now();
      const r = await request(BASE)
        .get(`/api/candidates/search?q=${encodeURIComponent(q)}`)
        .set("Cookie", cookie);
      latencies.push(Date.now() - start);
      expect(r.status).toBe(200);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    console.log(`Search perf — P50: ${p50}ms, P95: ${p95}ms`);

    // P50 should be well under 200ms for a small dataset
    expect(p50).toBeLessThan(200);
  }, 30_000);
});
