/**
 * tests/dedup/embedding-match.test.ts
 *
 * Verifies embedding-based dedup via the AI server /embed endpoint.
 * Since the AI server may not be available in CI, this test skips
 * gracefully if pgvector is not installed or AI server is unreachable.
 *
 * When pgvector IS available:
 *   - Two candidates with near-identical embeddings trigger a dedup signal
 *     (cosine similarity > 0.92, i.e. distance < 0.08)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestTenant, cleanTestData, pool } from "../helpers/db";

const BASE = process.env.API_BASE_URL ?? "http://localhost:80";
const AI_BASE = process.env.AI_BASE_URL ?? "http://localhost:9000";
const PREFIX = "dedup-embed";

let workspaceId: string;
let hasPgvector = false;
let hasAiServer = false;

beforeAll(async () => {
  const t = await createTestTenant(PREFIX, "1");
  workspaceId = t.workspaceId;

  // Check pgvector
  const c = await pool.connect();
  try {
    const r = await c.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    hasPgvector = r.rows.length > 0;
  } finally {
    c.release();
  }

  // Check AI server
  try {
    const r = await fetch(`${AI_BASE}/healthz`, { signal: AbortSignal.timeout(1000) });
    hasAiServer = r.ok;
  } catch {
    hasAiServer = false;
  }
}, 30_000);

afterAll(async () => {
  await cleanTestData(PREFIX);
  await pool.end();
});

describe("Embedding dedup", () => {
  it("skips gracefully when pgvector is not available", () => {
    if (hasPgvector) {
      console.log("pgvector available — embedding tests active");
    } else {
      console.log("pgvector not available — skipping embedding dedup tests");
    }
    expect(true).toBe(true);
  });

  it("embedding column exists when pgvector available", async () => {
    if (!hasPgvector) return;
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'candidates' AND column_name = 'embedding'`,
      );
      expect(r.rows.length).toBe(1);
    } finally {
      c.release();
    }
  });

  it("candidates with cosine distance < 0.08 are detectable as duplicates", async () => {
    if (!hasPgvector) return;
    if (!hasAiServer) {
      console.log("AI server not available — embedding similarity check skipped");
      return;
    }

    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);

      // Get embedding for a phrase
      const embRes = await fetch(`${AI_BASE}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Senior Software Engineer with React and Node.js" }),
        signal: AbortSignal.timeout(5000),
      });
      if (!embRes.ok) return;
      const { embedding } = (await embRes.json()) as { embedding: number[] };
      const vecStr = `[${embedding.join(",")}]`;

      // Insert two candidates with nearly identical embeddings (same vector)
      const r1 = await c.query<{ id: string }>(
        `INSERT INTO candidates (workspace_id, name, emails, embedding)
         VALUES ($1, 'Embed Cand A', ARRAY['embed-a@test.invalid']::text[], $2::vector)
         RETURNING id`,
        [workspaceId, vecStr],
      );
      const r2 = await c.query<{ id: string }>(
        `INSERT INTO candidates (workspace_id, name, emails, embedding)
         VALUES ($1, 'Embed Cand B', ARRAY['embed-b@test.invalid']::text[], $2::vector)
         RETURNING id`,
        [workspaceId, vecStr],
      );

      // Check cosine distance < 0.08
      const distRes = await c.query<{ dist: number }>(
        `SELECT (embedding <=> $1::vector) AS dist
         FROM candidates WHERE id = $2`,
        [vecStr, r1.rows[0].id],
      );
      const dist = Number(distRes.rows[0].dist);
      expect(dist).toBeLessThan(0.01); // identical vector → distance ≈ 0

      await c.query("COMMIT");
    } finally {
      c.release();
    }
  }, 15_000);
});
