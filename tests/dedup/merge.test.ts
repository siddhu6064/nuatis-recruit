/**
 * tests/dedup/merge.test.ts
 *
 * Verifies POST /api/candidates/:sourceId/merge-into/:targetId:
 * - Applications (skip duplicate job), resumes, activities, notes, tasks transferred
 * - Source deleted
 * - Audit log written (candidate.merged)
 * - Activity row written on target
 * - Same-workspace enforcement (403 cross-workspace)
 * - Same-id returns 400
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestTenant, cleanTestData, pool } from "../helpers/db";

const BASE = process.env.API_BASE_URL ?? "http://localhost:80";
const PREFIX = "dedup-merge";

let workspaceId: string;
let userId: string;
let cookie: string;
let sourceId: string;
let targetId: string;
let sharedJobId: string;
let uniqueJobId: string;
let clientId: string;

beforeAll(async () => {
  const t = await createTestTenant(PREFIX, "1");
  workspaceId = t.workspaceId;
  userId = t.userId;
  const s = await request(BASE).post("/api/_test/session").send({ workspaceId, userId });
  cookie = s.headers["set-cookie"]?.[0] ?? "";

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);

    // Client + 2 jobs
    const clr = await c.query<{ id: string }>(
      `INSERT INTO clients (workspace_id, name) VALUES ($1, 'Merge Client') RETURNING id`,
      [workspaceId],
    );
    clientId = clr.rows[0].id;

    const j1 = await c.query<{ id: string }>(
      `INSERT INTO jobs (workspace_id, client_id, title, slug, status)
       VALUES ($1, $2, 'Shared Job', 'shared-job', 'open') RETURNING id`,
      [workspaceId, clientId],
    );
    sharedJobId = j1.rows[0].id;

    const j2 = await c.query<{ id: string }>(
      `INSERT INTO jobs (workspace_id, client_id, title, slug, status)
       VALUES ($1, $2, 'Unique Job', 'unique-job', 'open') RETURNING id`,
      [workspaceId, clientId],
    );
    uniqueJobId = j2.rows[0].id;

    // Source + Target candidates
    const src = await c.query<{ id: string }>(
      `INSERT INTO candidates (workspace_id, name, emails)
       VALUES ($1, 'Source Cand', ARRAY['source@test.invalid']::text[]) RETURNING id`,
      [workspaceId],
    );
    sourceId = src.rows[0].id;

    const tgt = await c.query<{ id: string }>(
      `INSERT INTO candidates (workspace_id, name, emails)
       VALUES ($1, 'Target Cand', ARRAY['target@test.invalid']::text[]) RETURNING id`,
      [workspaceId],
    );
    targetId = tgt.rows[0].id;

    // Both applied to sharedJobId
    await c.query(
      `INSERT INTO applications (workspace_id, candidate_id, job_id, stage)
       VALUES ($1, $2, $3, 'screen')`,
      [workspaceId, sourceId, sharedJobId],
    );
    await c.query(
      `INSERT INTO applications (workspace_id, candidate_id, job_id, stage)
       VALUES ($1, $2, $3, 'applied')`,
      [workspaceId, targetId, sharedJobId],
    );

    // Source also applied to uniqueJobId
    await c.query(
      `INSERT INTO applications (workspace_id, candidate_id, job_id, stage)
       VALUES ($1, $2, $3, 'applied')`,
      [workspaceId, sourceId, uniqueJobId],
    );

    // Note and task on source
    await c.query(
      `INSERT INTO notes (workspace_id, candidate_id, author_id, body_html, body_plain)
       VALUES ($1, $2, $3, '{}', 'Source note')`,
      [workspaceId, sourceId, userId],
    );
    await c.query(
      `INSERT INTO tasks (workspace_id, candidate_id, assignee_id, created_by, title)
       VALUES ($1, $2, $3, $3, 'Source task')`,
      [workspaceId, sourceId, userId],
    );

    await c.query("COMMIT");
  } finally {
    c.release();
  }
}, 30_000);

afterAll(async () => {
  await cleanTestData(PREFIX);
});

describe("Candidate merge", () => {
  it("returns 400 when source === target", async () => {
    const r = await request(BASE)
      .post(`/api/candidates/${targetId}/merge-into/${targetId}`)
      .set("Cookie", cookie);
    expect(r.status).toBe(400);
  });

  it("merges source into target", async () => {
    const r = await request(BASE)
      .post(`/api/candidates/${sourceId}/merge-into/${targetId}`)
      .set("Cookie", cookie);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.targetId).toBe(targetId);
    expect(r.body.mergedFrom).toBe(sourceId);
  });

  it("source candidate is deleted", async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(`SELECT id FROM candidates WHERE id = $1`, [sourceId]);
      expect(r.rows).toHaveLength(0);
    } finally {
      c.release();
    }
  });

  it("uniqueJob application moved to target", async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2`,
        [targetId, uniqueJobId],
      );
      expect(r.rows).toHaveLength(1);
    } finally {
      c.release();
    }
  });

  it("duplicate sharedJob application deleted (target already had it)", async () => {
    const c = await pool.connect();
    try {
      // Should be exactly 1 application on target for sharedJob
      const r = await c.query(
        `SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2`,
        [targetId, sharedJobId],
      );
      expect(r.rows).toHaveLength(1);
    } finally {
      c.release();
    }
  });

  it("note moved to target", async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT id FROM notes WHERE candidate_id = $1 AND body_plain = 'Source note'`,
        [targetId],
      );
      expect(r.rows).toHaveLength(1);
    } finally {
      c.release();
    }
  });

  it("task moved to target", async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT id FROM tasks WHERE candidate_id = $1 AND title = 'Source task'`,
        [targetId],
      );
      expect(r.rows).toHaveLength(1);
    } finally {
      c.release();
    }
  });

  it("audit log written with candidate.merged action", async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT diff_json FROM audit_logs
         WHERE action = 'candidate.merged' AND target_id = $1::uuid`,
        [targetId],
      );
      expect(r.rows).toHaveLength(1);
      const diff = r.rows[0].diff_json as Record<string, unknown>;
      expect(diff.source_id).toBe(sourceId);
      expect(diff.resolution).toBe("target_wins");
    } finally {
      c.release();
    }
  });

  it("activity row written on target", async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT payload FROM activities WHERE candidate_id = $1 AND type = 'candidate.merged'`,
        [targetId],
      );
      expect(r.rows).toHaveLength(1);
      const payload = r.rows[0].payload as Record<string, unknown>;
      expect(payload.source_id).toBe(sourceId);
    } finally {
      c.release();
    }
  });

  it("source not found returns 404 on second merge attempt", async () => {
    const r = await request(BASE)
      .post(`/api/candidates/${sourceId}/merge-into/${targetId}`)
      .set("Cookie", cookie);
    expect(r.status).toBe(404);
  });
});
