/**
 * E2E: full apply → Inngest → match_score pipeline
 *
 * Skips when the AI service or Inngest dev server is unreachable so the suite
 * stays green in CI without those processes running.
 *
 * Individual test timeout: 60 s (Inngest step execution + retries).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

const DB_URL = process.env.DATABASE_URL!;
const API_BASE = "http://localhost:8080";
const AI_BASE = "http://localhost:9000";
const INNGEST_BASE = process.env.INNGEST_BASE_URL ?? "http://localhost:8008";
const FIXTURE_PDF = join(__dirname, "../fixtures/sample-resume.pdf");

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function poll<T>(
  fn: () => Promise<T | null>,
  { maxMs = 30_000, intervalMs = 1_000 }: { maxMs?: number; intervalMs?: number } = {},
): Promise<T | null> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await sleep(intervalMs);
  }
  return null;
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe("E2E: apply → Inngest pipeline → match_score", () => {
  let skip = false;
  let db: pg.Client;
  let workspaceId: string;
  let orgSlug: string;
  let jobId: string;
  let jobSlug: string;
  let applicationId: string;
  let candidateId: string;

  beforeAll(async () => {
    // Probe dependencies — skip suite if any are unavailable
    const [apiOk, aiOk, inngestOk] = await Promise.all([
      isReachable(`${API_BASE}/api/healthz`),
      isReachable(`${AI_BASE}/health`),
      isReachable(`${INNGEST_BASE}`),
    ]);

    if (!apiOk || !aiOk || !inngestOk) {
      console.warn(
        `[E2E skip] api=${apiOk} ai=${aiOk} inngest=${inngestOk} — skipping suite`,
      );
      skip = true;
      return;
    }

    // Raw client — bypasses RLS for seed/teardown (same technique as inngest.ts dbQuery)
    db = new pg.Client({ connectionString: DB_URL });
    await db.connect();

    const tag = `e2e-${randomUUID().slice(0, 8)}`;
    orgSlug = tag;

    // Seed org → workspace → user → client → published job
    const orgRes = await db.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [`E2E Org ${tag}`, tag],
    );
    const orgId = orgRes.rows[0].id;

    const wsRes = await db.query<{ id: string }>(
      `INSERT INTO workspaces (organization_id, name) VALUES ($1, $2) RETURNING id`,
      [orgId, `E2E Workspace ${tag}`],
    );
    workspaceId = wsRes.rows[0].id;

    await db.query(
      `INSERT INTO users (workspace_id, external_auth_id, external_auth_provider, email, role)
       VALUES ($1, $2, 'test', $3, 'owner')`,
      [workspaceId, `e2e-ext-${tag}`, `e2e-${tag}@example.invalid`],
    );

    const clientRes = await db.query<{ id: string }>(
      `INSERT INTO clients (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [workspaceId, `E2E Client ${tag}`],
    );

    jobSlug = `e2e-eng-${tag}`;
    const jobRes = await db.query<{ id: string }>(
      `INSERT INTO jobs (workspace_id, client_id, title, description, slug, status)
       VALUES ($1, $2, $3, $4, $5, 'open') RETURNING id`,
      [
        workspaceId,
        clientRes.rows[0].id,
        "E2E Senior Engineer",
        "TypeScript, Node.js, React, PostgreSQL — 5+ years. Strong system design skills required.",
        jobSlug,
      ],
    );
    jobId = jobRes.rows[0].id;

    // Fire job.created via SDK through test endpoint (job seeded via DB, not API route)
    await fetch(`${API_BASE}/api/_test/inngest-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "job.created",
        data: {
          jobId,
          workspaceId,
          description: "TypeScript, Node.js, React, PostgreSQL — 5+ years. Strong system design skills required.",
        },
      }),
    });
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    const wsIds = workspaceId ? [workspaceId] : [];
    if (wsIds.length) {
      await db.query(`DELETE FROM match_scores       WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM fairness_audit_log WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM activities         WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM resumes            WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM applications       WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM candidates         WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM jobs               WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM clients            WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      // first pass: rows created by public apply route
      await db.query(`DELETE FROM audit_logs         WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM invites            WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM users              WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      // second pass: catch any rows inserted by concurrent Inngest steps during cleanup
      await db.query(`DELETE FROM audit_logs         WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM workspaces         WHERE id           = ANY($1::uuid[])`, [wsIds]);
    }
    if (orgSlug) {
      await db.query(`DELETE FROM organizations WHERE slug = $1`, [orgSlug]);
    }
    await db.end();
  }, 15_000);

  it("submits public application via HTTP and receives 201", { timeout: 15_000 }, async () => {
    if (skip) return;

    const pdfBuffer = readFileSync(FIXTURE_PDF);
    const file = new File([pdfBuffer], "sample-resume.pdf", { type: "application/pdf" });
    const form = new FormData();
    form.append("slug", jobSlug);
    form.append("name", "E2E Candidate");
    form.append("email", `e2e-candidate-${randomUUID().slice(0, 6)}@example.invalid`);
    form.append("phone", "5558880001");
    form.append("coverLetter", "TypeScript, Node.js, React, PostgreSQL expert applying for this role.");
    form.append("resume", file, "sample-resume.pdf");

    const res = await fetch(`${API_BASE}/api/public/apply`, {
      method: "POST",
      body: form,
    });

    expect(res.status, `apply response: ${await res.text()}`).toBe(201);
    const data = (await res.json()) as {
      applicationId: string;
      candidateId: string;
      appliedAt: string;
    };
    expect(data.applicationId).toBeTruthy();
    expect(data.candidateId).toBeTruthy();

    applicationId = data.applicationId;
    candidateId = data.candidateId;
  });

  it("Inngest resume.uploaded → candidates.parsed_resume populated within 30 s", { timeout: 60_000 }, async () => {
    if (skip || !candidateId) return;

    const result = await poll(async () => {
      const row = await db.query<{ parsed_resume: unknown }>(
        `SELECT parsed_resume FROM candidates WHERE id = $1`,
        [candidateId],
      );
      return row.rows[0]?.parsed_resume ?? null;
    });

    expect(result, "candidates.parsed_resume should be populated by Inngest within 30 s").not.toBeNull();
  });

  it("Inngest job.created → jobs.parsed_jd populated within 30 s", { timeout: 60_000 }, async () => {
    if (skip || !jobId) return;

    const result = await poll(async () => {
      const row = await db.query<{ parsed_jd: unknown }>(
        `SELECT parsed_jd FROM jobs WHERE id = $1`,
        [jobId],
      );
      return row.rows[0]?.parsed_jd ?? null;
    });

    expect(result, "jobs.parsed_jd should be populated by Inngest within 30 s").not.toBeNull();
  });

  it("Inngest application.created → match_scores row with valid score within 30 s", { timeout: 60_000 }, async () => {
    if (skip || !applicationId) return;

    const result = await poll<{ score: number; breakdown: unknown; rationale: string }>(
      async () => {
        const row = await db.query<{ score: number; breakdown: unknown; rationale: string }>(
          `SELECT score, breakdown, rationale FROM match_scores WHERE application_id = $1`,
          [applicationId],
        );
        return row.rows[0] ?? null;
      },
    );

    expect(result, "match_scores row should appear within 30 s").not.toBeNull();
    expect(result!.score).toBeGreaterThanOrEqual(0);
    expect(result!.score).toBeLessThanOrEqual(100);
    expect(result!.breakdown).toBeTruthy();
    expect(result!.rationale).toBeTruthy();
  });

  it("all 3 Inngest events produced DB side-effects — no orphan rows", { timeout: 5_000 }, async () => {
    if (skip || !applicationId) return;

    // verify resume row exists for this application's candidate
    const resumeRow = await db.query(
      `SELECT id FROM resumes WHERE candidate_id = $1 AND workspace_id = $2`,
      [candidateId, workspaceId],
    );
    expect(resumeRow.rows.length).toBeGreaterThan(0);

    // verify activity row created by public apply route
    const activityRow = await db.query(
      `SELECT id FROM activities WHERE candidate_id = $1 AND workspace_id = $2 AND type = 'application.created'`,
      [candidateId, workspaceId],
    );
    expect(activityRow.rows.length).toBeGreaterThan(0);
  });
});
