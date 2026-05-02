/**
 * B3-T009b: Match flow — creates candidate+job+application, calls /match directly
 * on the AI service, writes match_scores, and asserts the row has correct shape.
 *
 * NOTE: This test exercises the AI service + DB integration directly (simulating
 * what the Inngest score-application function does). The full Inngest pipeline
 * (event send → function execute → DB write) requires the Inngest dev server
 * running alongside the API server — that is a separate integration concern.
 *
 * Requires: DATABASE_URL set + AI service running at AI_SERVICE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, withClient, cleanTestData, createTestTenant } from "../helpers/db";

const AI_BASE = process.env.AI_SERVICE_URL ?? "http://localhost:9000";
const PREFIX = "b3mf";

async function checkServiceAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${AI_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

describe("Match flow — DB integration", () => {
  let available = false;
  let workspaceId: string;
  let jobId: string;
  let candidateId: string;
  let resumeId: string;
  let applicationId: string;

  beforeAll(async () => {
    available = await checkServiceAvailable();
    const { workspaceId: wsId } = await createTestTenant(PREFIX, "1");
    workspaceId = wsId;

    // Create client
    const clientRes = await pool.query<{ id: string }>(
      `INSERT INTO clients (workspace_id, name) VALUES ($1, 'B3 Client') RETURNING id`,
      [workspaceId],
    );
    const clientId = clientRes.rows[0].id;

    // Create job with stub parsed_jd
    const jobRes = await pool.query<{ id: string }>(
      `INSERT INTO jobs (workspace_id, client_id, title, description, location, status, slug, parsed_jd)
       VALUES ($1, $2, 'Senior Python Engineer', 'We need python, react, postgresql skills.', 'San Francisco, CA', 'open', 'senior-python-eng-b3', $3)
       RETURNING id`,
      [
        workspaceId,
        clientId,
        JSON.stringify({
          required_skills: ["python", "react", "postgresql"],
          seniority_level: "senior",
          key_responsibilities: ["Build APIs", "Review code"],
          nice_to_have_skills: ["kubernetes"],
          must_haves: ["python"],
          model_version: "claude-sonnet-4-7-stub",
        }),
      ],
    );
    jobId = jobRes.rows[0].id;

    // Create candidate with stub parsed_resume
    const candRes = await pool.query<{ id: string }>(
      `INSERT INTO candidates (workspace_id, name, emails, source, parsed_resume, location)
       VALUES ($1, 'B3 Test Candidate', ARRAY['b3test@test.invalid'], 'test', $2, 'San Francisco, CA')
       RETURNING id`,
      [
        workspaceId,
        JSON.stringify({
          name: "B3 Test Candidate",
          skills: ["python", "react"],
          seniority_level: "senior",
          location: "San Francisco, CA",
          work_history: [{ title: "Senior Engineer", company: "Stub Corp", start_date: "2018-01", current: true }],
        }),
      ],
    );
    candidateId = candRes.rows[0].id;

    // Create resume
    const resumeRes = await pool.query<{ id: string }>(
      `INSERT INTO resumes (workspace_id, candidate_id, file_url, parsed, parser_version)
       VALUES ($1, $2, 'https://example.com/b3_resume.pdf', $3, 'claude-sonnet-4-7-stub')
       RETURNING id`,
      [
        workspaceId,
        candidateId,
        JSON.stringify({
          name: "B3 Test Candidate",
          skills: ["python", "react"],
          seniority_level: "senior",
          location: "San Francisco, CA",
          work_history: [{ title: "Senior Engineer", company: "Stub Corp", start_date: "2018-01", current: true }],
        }),
      ],
    );
    resumeId = resumeRes.rows[0].id;

    // Create application
    const appRes = await pool.query<{ id: string }>(
      `INSERT INTO applications (workspace_id, candidate_id, job_id, stage, source)
       VALUES ($1, $2, $3, 'applied', 'test') RETURNING id`,
      [workspaceId, candidateId, jobId],
    );
    applicationId = appRes.rows[0].id;
  });

  afterAll(async () => {
    // Clean match scores first (FK to applications)
    await pool.query(
      `DELETE FROM match_scores WHERE workspace_id IN (
         SELECT w.id FROM workspaces w
         JOIN organizations o ON o.id = w.organization_id
         WHERE o.slug LIKE $1
       )`,
      [`${PREFIX}%`],
    );
    await cleanTestData(PREFIX);
  });

  it("match_scores table exists with correct columns", async () => {
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'match_scores'
       ORDER BY column_name`,
    );
    const cols = res.rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).toContain("id");
    expect(cols).toContain("workspace_id");
    expect(cols).toContain("application_id");
    expect(cols).toContain("score");
    expect(cols).toContain("breakdown");
    expect(cols).toContain("rationale");
    expect(cols).toContain("evidence_quotes");
    expect(cols).toContain("model_version");
    expect(cols).toContain("created_at");
  });

  it("fairness_audit_log table exists with correct columns", async () => {
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'fairness_audit_log'
       ORDER BY column_name`,
    );
    const cols = res.rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).toContain("id");
    expect(cols).toContain("workspace_id");
    expect(cols).toContain("target_type");
    expect(cols).toContain("target_id");
    expect(cols).toContain("signals_stripped");
    expect(cols).toContain("created_at");
  });

  it("calls /match and gets a valid score for the test application", async () => {
    if (!available) {
      console.warn(`AI service not available at ${AI_BASE} — skipping /match call`);
      return;
    }

    const res = await fetch(`${AI_BASE}/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resume_id: resumeId,
        job_id: jobId,
        workspace_id: workspaceId,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    expect(body).toHaveProperty("score");
    expect(body).toHaveProperty("breakdown");
    expect(body).toHaveProperty("rationale");
    expect(body).toHaveProperty("evidence_quotes");
    expect(body).toHaveProperty("model_version");

    const score = body.score as number;
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);

    const bd = body.breakdown as Record<string, number>;
    expect(Object.keys(bd)).toHaveLength(4);
    expect(bd).toHaveProperty("skills");
    expect(bd).toHaveProperty("experience");
    expect(bd).toHaveProperty("seniority");
    expect(bd).toHaveProperty("location");

    expect(String(body.model_version)).toContain("stub");
    expect(Array.isArray(body.evidence_quotes)).toBe(true);

    // Write match score to DB (simulating Inngest job)
    await pool.query(
      `INSERT INTO match_scores
         (workspace_id, application_id, score, breakdown, rationale, evidence_quotes, model_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (application_id) DO UPDATE SET
         score = EXCLUDED.score,
         breakdown = EXCLUDED.breakdown,
         rationale = EXCLUDED.rationale,
         model_version = EXCLUDED.model_version`,
      [
        workspaceId,
        applicationId,
        score,
        JSON.stringify(bd),
        body.rationale,
        JSON.stringify(body.evidence_quotes),
        body.model_version,
      ],
    );
  });

  it("match_scores row exists in DB after write with correct shape", async () => {
    if (!available) {
      // Even without AI service, verify the table exists and can accept a write
      await pool.query(
        `INSERT INTO match_scores
           (workspace_id, application_id, score, breakdown, rationale, evidence_quotes, model_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (application_id) DO UPDATE SET score = EXCLUDED.score`,
        [workspaceId, applicationId, 72, JSON.stringify({ skills: 20, experience: 20, seniority: 20, location: 8 }), "stub rationale", "[]", "claude-sonnet-4-7-stub"],
      );
    }

    const res = await pool.query<{
      score: number;
      breakdown: Record<string, number>;
      rationale: string;
      model_version: string;
    }>(
      `SELECT score, breakdown, rationale, model_version FROM match_scores WHERE application_id = $1`,
      [applicationId],
    );

    expect(res.rows.length).toBe(1);
    const row = res.rows[0];

    expect(row.score).toBeGreaterThanOrEqual(0);
    expect(row.score).toBeLessThanOrEqual(100);
    expect(Object.keys(row.breakdown)).toHaveLength(4);
    expect(String(row.model_version)).toContain("stub");
  });

  it("match_scores upsert does not create duplicate rows (unique constraint on application_id)", async () => {
    // Insert twice — second should update, not insert
    await pool.query(
      `INSERT INTO match_scores
         (workspace_id, application_id, score, breakdown, rationale, evidence_quotes, model_version)
       VALUES ($1, $2, 80, '{"skills":32,"experience":24,"seniority":16,"location":8}'::jsonb, 'updated', '[]', 'claude-sonnet-4-7-stub')
       ON CONFLICT (application_id) DO UPDATE SET score = EXCLUDED.score, rationale = EXCLUDED.rationale`,
      [workspaceId, applicationId],
    );

    const res = await pool.query(
      `SELECT COUNT(*) as cnt FROM match_scores WHERE application_id = $1`,
      [applicationId],
    );
    expect(Number(res.rows[0].cnt)).toBe(1);

    // Verify the score was updated
    const row = await pool.query<{ score: number; rationale: string }>(
      `SELECT score, rationale FROM match_scores WHERE application_id = $1`,
      [applicationId],
    );
    expect(row.rows[0].score).toBe(80);
    expect(row.rows[0].rationale).toBe("updated");
  });
});
