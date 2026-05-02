/**
 * Nuatis Recruit — E2E Demo Loop
 *
 * Proves the full apply → Inngest → match_score pipeline end-to-end.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run demo-loop
 *
 * Flow:
 *  1. Seed org / workspace / user / client / published job directly in DB
 *  2. Submit a public application via HTTP (multipart PDF upload)
 *  3. Poll match_scores for up to 30 s
 *  4. Print PASS / FAIL with score and timing
 *  5. Clean up seed rows
 */

import pg from "pg";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("DATABASE_URL env var is required");

const API_BASE = process.env.API_BASE ?? "http://localhost:8080";
const INNGEST_BASE = process.env.INNGEST_BASE_URL ?? "http://localhost:8008";
const FIXTURE_PDF = join(__dirname, "../../tests/fixtures/sample-resume.pdf");

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function rawClient(): Promise<pg.Client> {
  // Raw client — no SET ROLE — bypasses RLS for seed/teardown
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  return client;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Nuatis Recruit — E2E Demo Loop ===\n");
  const t0 = Date.now();
  const tag = `demo-${randomUUID().slice(0, 8)}`;

  const db = await rawClient();
  let workspaceId: string | null = null;

  try {
    // 1. Seed org + workspace + user ──────────────────────────────────────
    const orgRes = await db.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Demo Org ${tag}`, tag],
    );
    const orgId = orgRes.rows[0].id;

    const wsRes = await db.query<{ id: string }>(
      `INSERT INTO workspaces (organization_id, name) VALUES ($1, $2) RETURNING id`,
      [orgId, `Demo Workspace ${tag}`],
    );
    workspaceId = wsRes.rows[0].id;

    await db.query(
      `INSERT INTO users (workspace_id, external_auth_id, external_auth_provider, email, role)
       VALUES ($1, $2, 'test', $3, 'owner')`,
      [workspaceId, `demo-ext-${tag}`, `demo-${tag}@example.invalid`],
    );
    console.log(`✓  Org / workspace / user seeded (workspaceId=${workspaceId})`);

    // 2. Seed client ───────────────────────────────────────────────────────
    const clientRes = await db.query<{ id: string }>(
      `INSERT INTO clients (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [workspaceId, `Acme Corp ${tag}`],
    );
    const clientId = clientRes.rows[0].id;
    console.log(`✓  Client seeded (clientId=${clientId})`);

    // 3. Seed + publish job ────────────────────────────────────────────────
    const slug = `senior-eng-${tag}`;
    const jobRes = await db.query<{ id: string }>(
      `INSERT INTO jobs (workspace_id, client_id, title, description, slug, status)
       VALUES ($1, $2, $3, $4, $5, 'open') RETURNING id`,
      [
        workspaceId,
        clientId,
        "Senior Software Engineer",
        "We need a senior engineer with 5+ years of TypeScript, Node.js, React, and PostgreSQL.",
        slug,
      ],
    );
    const jobId = jobRes.rows[0].id;
    console.log(`✓  Job seeded + published (jobId=${jobId}, slug=${slug})`);

    // 3b. Fire job.created via dev-only SDK endpoint (job seeded via DB, bypasses API route)
    const fireRes = await fetch(`${API_BASE}/api/_test/inngest-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "job.created",
        data: {
          jobId,
          workspaceId,
          description: "We need a senior engineer with 5+ years of TypeScript, Node.js, React, and PostgreSQL.",
        },
      }),
    });
    if (!fireRes.ok) {
      console.warn(`  ⚠  job.created send returned ${fireRes.status}`);
    } else {
      console.log(`✓  job.created event sent to Inngest`);
    }

    // 4. Submit public application via HTTP ────────────────────────────────
    const pdfBuffer = readFileSync(FIXTURE_PDF);
    const file = new File([pdfBuffer], "sample-resume.pdf", { type: "application/pdf" });
    const form = new FormData();
    form.append("slug", slug);
    form.append("name", "Jane Demo");
    form.append("email", `jane-${tag}@example.invalid`);
    form.append("phone", "5559990001");
    form.append(
      "coverLetter",
      "I am an excellent match — TypeScript, React, Node.js, PostgreSQL are my daily stack.",
    );
    form.append("resume", file, "sample-resume.pdf");

    const applyRes = await fetch(`${API_BASE}/api/public/apply`, {
      method: "POST",
      body: form,
    });

    if (!applyRes.ok) {
      const body = await applyRes.text();
      throw new Error(`Public apply HTTP ${applyRes.status}: ${body}`);
    }

    const applyData = (await applyRes.json()) as {
      applicationId: string;
      candidateId: string;
      appliedAt: string;
    };
    const { applicationId } = applyData;
    const tApply = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`✓  Application submitted at t=${tApply}s (applicationId=${applicationId})`);

    // 5. Poll match_scores ─────────────────────────────────────────────────
    console.log(`   Polling match_scores (max 30 s)…`);
    let score: number | null = null;
    let tScore: string | null = null;

    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const row = await db.query<{ score: number; breakdown: unknown; rationale: string }>(
        `SELECT score, breakdown, rationale FROM match_scores WHERE application_id = $1`,
        [applicationId],
      );
      if (row.rows.length > 0) {
        score = row.rows[0].score;
        tScore = `t=${((Date.now() - t0) / 1000).toFixed(1)}s`;
        break;
      }
      if ((i + 1) % 5 === 0) process.stdout.write(`   … still waiting (${i + 1}s)\n`);
    }

    // 6. Result ────────────────────────────────────────────────────────────
    console.log("\n=== RESULT ===");
    if (score !== null && score >= 0 && score <= 100) {
      console.log(`PASS — score=${score}/100 appeared at ${tScore} after apply submit`);
    } else {
      console.error(`FAIL — no match_scores row found within 30 s (applicationId=${applicationId})`);
      process.exitCode = 1;
    }
  } finally {
    // Cleanup ────────────────────────────────────────────────────────────
    if (workspaceId) {
      const wsIds = [workspaceId];
      await db.query(`DELETE FROM match_scores       WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM fairness_audit_log WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM activities         WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM resumes            WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM applications       WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM candidates         WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM jobs               WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM clients            WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      // audit_logs first pass — catches rows from public apply route
      await db.query(`DELETE FROM audit_logs         WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM invites            WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM users              WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      // second pass in case any concurrent process inserted audit_logs during cleanup
      await db.query(`DELETE FROM audit_logs         WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM workspaces         WHERE id           = ANY($1::uuid[])`, [wsIds]);
      await db.query(`DELETE FROM organizations      WHERE slug         = $1`, [tag]);
      console.log("✓  Seed data cleaned up");
    }
    await db.end();
  }
}

main().catch((err) => {
  console.error("FAIL —", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
