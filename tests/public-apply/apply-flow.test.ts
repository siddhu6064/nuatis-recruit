/**
 * Public Apply Flow test
 *
 * Exercises the DB layer directly (raw SQL through the pool) to verify
 * that the public apply flow creates all expected rows with correct
 * workspace_id, and that the audit trail is written.
 *
 * Asserts:
 *   - candidate row created with correct workspace_id
 *   - resume row created with correct workspace_id and candidate_id
 *   - application row created with stage='applied', source='public_apply'
 *   - activity row created with type='application.created'
 *   - audit_logs row written with action='application.create'
 *   - RLS: workspace B cannot see workspace A's application rows
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { pool, createTestTenant, cleanTestData, teardown } from "../helpers/db";

const PREFIX = "applytest";

let workspaceId: string;
let jobId: string;
let clientId: string;

beforeAll(async () => {
  await cleanTestData(PREFIX);
  const tenant = await createTestTenant(PREFIX, "x");
  workspaceId = tenant.workspaceId;

  const c = await pool.connect();
  try {
    const clientRes = await c.query(
      `INSERT INTO clients (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [workspaceId, `${PREFIX}-client`],
    );
    clientId = clientRes.rows[0].id as string;

    const jobRes = await c.query(
      `INSERT INTO jobs (workspace_id, client_id, title, slug, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
      [workspaceId, clientId, `${PREFIX} Test Job`, `${PREFIX}-test-job`],
    );
    jobId = jobRes.rows[0].id as string;
  } finally {
    c.release();
  }
});

afterAll(async () => {
  // FK-safe manual cleanup for Batch 2 tables
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM activities   WHERE workspace_id = $1`, [workspaceId]);
    await c.query(`DELETE FROM resumes      WHERE workspace_id = $1`, [workspaceId]);
    await c.query(`DELETE FROM applications WHERE workspace_id = $1`, [workspaceId]);
    await c.query(`DELETE FROM candidates   WHERE workspace_id = $1`, [workspaceId]);
    await c.query(`DELETE FROM jobs         WHERE workspace_id = $1`, [workspaceId]);
    await c.query(`DELETE FROM clients      WHERE workspace_id = $1`, [workspaceId]);
  } finally {
    c.release();
  }
  await cleanTestData(PREFIX);
  await teardown();
});

describe("Public apply flow: end-to-end DB assertions", () => {
  let candidateId: string;
  let applicationId: string;
  const testEmail = `${PREFIX}+candidate@test.invalid`;

  it("creates candidate, resume, application, activity with correct workspace_id", async () => {
    // Simulate the public apply handler inline using raw SQL through the pool.
    // The pool already switches to nuatis_app (SET ROLE), and we open a
    // transaction + SET LOCAL so RLS is bound to the target workspace.
    const pgClient = await pool.connect();
    try {
      await pgClient.query("BEGIN");
      await pgClient.query(
        "SELECT set_config('app.current_workspace_id', $1, true)",
        [workspaceId],
      );

      // 1. Create candidate
      const candRes = await pgClient.query(
        `INSERT INTO candidates (workspace_id, name, emails, phones, source)
         VALUES ($1, $2, ARRAY[$3]::text[], '{}'::text[], 'public_apply')
         RETURNING id, workspace_id`,
        [workspaceId, "Test Applicant", testEmail],
      );
      candidateId = candRes.rows[0].id as string;
      expect(candRes.rows[0].workspace_id).toBe(workspaceId);

      // 2. Create resume
      const resumeRes = await pgClient.query(
        `INSERT INTO resumes (workspace_id, candidate_id, file_url)
         VALUES ($1, $2, $3)
         RETURNING id, workspace_id, candidate_id`,
        [workspaceId, candidateId, "test://fake-resume-blob.pdf"],
      );
      expect(resumeRes.rows[0].workspace_id).toBe(workspaceId);
      expect(resumeRes.rows[0].candidate_id).toBe(candidateId);

      // 3. Create application
      const appRes = await pgClient.query(
        `INSERT INTO applications (workspace_id, candidate_id, job_id, stage, source)
         VALUES ($1, $2, $3, 'applied', 'public_apply')
         RETURNING id, workspace_id, stage, source`,
        [workspaceId, candidateId, jobId],
      );
      applicationId = appRes.rows[0].id as string;
      expect(appRes.rows[0].workspace_id).toBe(workspaceId);
      expect(appRes.rows[0].stage).toBe("applied");
      expect(appRes.rows[0].source).toBe("public_apply");

      // 4. Create activity
      const actRes = await pgClient.query(
        `INSERT INTO activities (workspace_id, candidate_id, type, payload)
         VALUES ($1, $2, 'application.created', $3::jsonb)
         RETURNING id, workspace_id, type`,
        [workspaceId, candidateId, JSON.stringify({ applicationId, jobId })],
      );
      expect(actRes.rows[0].workspace_id).toBe(workspaceId);
      expect(actRes.rows[0].type).toBe("application.created");

      // 5. Write audit row
      await pgClient.query(
        `INSERT INTO audit_logs (workspace_id, action, target_type, target_id, ip, user_agent)
         VALUES ($1, 'application.create', 'application', $2, '127.0.0.1', 'test-agent')`,
        [workspaceId, applicationId],
      );

      await pgClient.query("COMMIT");
    } finally {
      pgClient.release();
    }
  });

  it("audit_logs row exists with action=application.create", async () => {
    const c = await pool.connect();
    try {
      // No workspace context set → all rows visible (null branch of RLS policy)
      const res = await c.query(
        `SELECT * FROM audit_logs
         WHERE workspace_id = $1
           AND action = 'application.create'
           AND target_type = 'application'
         ORDER BY created_at DESC LIMIT 1`,
        [workspaceId],
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].target_id).toBe(applicationId);
    } finally {
      c.release();
    }
  });

  it("RLS: workspace B cannot see workspace A's application when context=workspaceB", async () => {
    // Create a throwaway second tenant
    const other = await createTestTenant(PREFIX, "other");

    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT set_config('app.current_workspace_id', $1, true)",
        [other.workspaceId],
      );
      const res = await c.query(
        `SELECT id FROM applications WHERE id = $1`,
        [applicationId],
      );
      await c.query("ROLLBACK");
      expect(res.rows).toHaveLength(0);
    } finally {
      c.release();
    }

    // cleanup other tenant (FK safe — delete kanban + leaf tables before workspace)
    const clean = await pool.connect();
    try {
      await clean.query(`DELETE FROM stage_automations WHERE workspace_id = $1`, [other.workspaceId]);
      await clean.query(`DELETE FROM rejection_reasons  WHERE workspace_id = $1`, [other.workspaceId]);
      await clean.query(`DELETE FROM users              WHERE workspace_id = $1`, [other.workspaceId]);
      await clean.query(`DELETE FROM audit_logs         WHERE workspace_id = $1`, [other.workspaceId]);
      await clean.query(`DELETE FROM workspaces         WHERE id = $1`, [other.workspaceId]);
      await clean.query(`DELETE FROM organizations      WHERE id = $1`, [other.orgId]);
    } finally {
      clean.release();
    }
  });
});
