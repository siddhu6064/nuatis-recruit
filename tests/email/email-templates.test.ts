/**
 * Batch 6A.5 — email_templates tests
 *
 * Coverage:
 *   Merge-field engine (8 pure unit tests — no HTTP)
 *   CRUD + role guards (7 HTTP tests)
 *   RLS isolation (2 HTTP tests)
 *   Render endpoint (4 HTTP tests)
 *   Archived template (1 HTTP test)
 *   Render → Compose E2E (1 HTTP test)
 *   Total: 23 tests
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestTenant, cleanTestData, pool } from "../helpers/db";
import { interpolate, getMissingTokens } from "../../artifacts/api-server/src/lib/email/merge-fields";

const BASE = process.env.API_BASE_URL ?? "http://localhost:80";
const PREFIX = "tmpl6a5";

// ─── Test state ───────────────────────────────────────────────────
let ownerCookie: string;
let recruiterCookie: string;
let altOwnerCookie: string;

let workspaceId: string;
let altWorkspaceId: string;
let ownerUserId: string;
let candidateId: string;
let jobId: string;

beforeAll(async () => {
  await cleanTestData(PREFIX);

  // Primary workspace (owner role)
  const primary = await createTestTenant(PREFIX, "A");
  workspaceId  = primary.workspaceId;
  ownerUserId  = primary.userId;

  // Secondary workspace (for isolation tests)
  const secondary = await createTestTenant(PREFIX, "B");
  altWorkspaceId = secondary.workspaceId;

  // Add a recruiter user to the primary workspace
  const client = await pool.connect();
  let recruiterUserId: string;
  try {
    const rResult = await client.query(
      `INSERT INTO users (workspace_id, external_auth_id, external_auth_provider, email, role)
       VALUES ($1, $2, 'test', $3, 'recruiter') RETURNING id`,
      [workspaceId, `test-ext-${PREFIX}-recruiter`, `${PREFIX}+recruiter@test.invalid`],
    );
    recruiterUserId = rResult.rows[0].id;

    // Candidate in primary workspace
    const cResult = await client.query(
      `INSERT INTO candidates (workspace_id, name, emails, current_title, current_company, location)
       VALUES ($1, 'Alex Rivera', ARRAY['alex@example.com'], 'Staff Engineer', 'Acme Corp', 'San Francisco, CA')
       RETURNING id`,
      [workspaceId],
    );
    candidateId = cResult.rows[0].id;

    // Client in primary workspace
    const clResult = await client.query(
      `INSERT INTO clients (workspace_id, name) VALUES ($1, 'Beta Inc') RETURNING id`,
      [workspaceId],
    );
    const clientId: string = clResult.rows[0].id;

    // Job in primary workspace linked to client
    const jResult = await client.query(
      `INSERT INTO jobs (workspace_id, client_id, title, slug, location, salary_min, salary_max, status)
       VALUES ($1, $2, 'Senior Backend Engineer', $3, 'Remote', 180000, 220000, 'open')
       RETURNING id`,
      [workspaceId, clientId, `${PREFIX}-sbe-${Date.now()}`],
    );
    jobId = jResult.rows[0].id;
  } finally {
    client.release();
  }

  // Create sessions via the running server's /_test/session endpoint
  const ownerSession = await request(BASE)
    .post("/api/_test/session")
    .send({ workspaceId, userId: ownerUserId });
  ownerCookie = ownerSession.headers["set-cookie"]?.[0] ?? "";

  const recruiterSession = await request(BASE)
    .post("/api/_test/session")
    .send({ workspaceId, userId: recruiterUserId });
  recruiterCookie = recruiterSession.headers["set-cookie"]?.[0] ?? "";

  const altSession = await request(BASE)
    .post("/api/_test/session")
    .send({ workspaceId: altWorkspaceId, userId: secondary.userId });
  altOwnerCookie = altSession.headers["set-cookie"]?.[0] ?? "";
}, 30_000);

afterAll(async () => {
  await cleanTestData(PREFIX);
});

// ═════════════════════════════════════════════════════════════════
// Merge-field engine unit tests (pure, no HTTP)
// ═════════════════════════════════════════════════════════════════
describe("merge-field engine", () => {
  const fullCtx = {
    candidate: {
      name: "Jordan Lee",
      email: "jordan@example.com",
      currentTitle: "Product Designer",
      currentCompany: "Designco",
      location: "New York, NY",
    },
    job: { title: "Head of Design", location: "Remote", salaryMin: 150000, salaryMax: 200000 },
    client: { name: "Gamma Ltd" },
    recruiter: { name: "Sam Chen", email: "sam@agency.com" },
  };

  it("resolves all candidate tokens", () => {
    const tmpl =
      "{{candidate.name}} | {{candidate.email}} | {{candidate.currentTitle}} | {{candidate.currentCompany}} | {{candidate.location}}";
    expect(interpolate(tmpl, fullCtx)).toBe(
      "Jordan Lee | jordan@example.com | Product Designer | Designco | New York, NY",
    );
  });

  it("resolves all job + client + recruiter tokens", () => {
    const tmpl =
      "{{job.title}} | {{job.location}} | {{job.salaryRange}} | {{client.name}} | {{recruiter.name}} | {{recruiter.email}}";
    expect(interpolate(tmpl, fullCtx)).toBe(
      "Head of Design | Remote | $150,000 \u2013 $200,000 | Gamma Ltd | Sam Chen | sam@agency.com",
    );
  });

  it("leaves unknown tokens verbatim", () => {
    const tmpl = "Hello {{candidate.name}} and {{unknown.field}}";
    expect(interpolate(tmpl, fullCtx)).toBe("Hello Jordan Lee and {{unknown.field}}");
  });

  it("resolves missing known field to empty string", () => {
    const ctx = { candidate: { name: "Jordan Lee" } };
    expect(interpolate("{{candidate.currentTitle}}", ctx)).toBe("");
    expect(interpolate("{{client.name}}", ctx)).toBe("");
  });

  it("derives firstName from first word of name", () => {
    expect(interpolate("{{candidate.firstName}}", fullCtx)).toBe("Jordan");
    expect(interpolate("{{recruiter.firstName}}", fullCtx)).toBe("Sam");
    expect(interpolate("{{candidate.firstName}}", { candidate: { name: "Cher" } })).toBe("Cher");
  });

  it("formats job.salaryRange correctly", () => {
    expect(interpolate("{{job.salaryRange}}", { job: { salaryMin: 100000, salaryMax: 150000 } })).toBe(
      "$100,000 \u2013 $150,000",
    );
    expect(interpolate("{{job.salaryRange}}", { job: { salaryMin: 120000 } })).toBe("$120,000+");
    expect(interpolate("{{job.salaryRange}}", { job: {} })).toBe("");
  });

  it("getMissingTokens reports missing known fields and deduplicates", () => {
    const ctx = { candidate: { name: "Jordan Lee" } };
    const tmpl = "{{candidate.email}} intro {{candidate.email}} at {{client.name}}";
    const missing = getMissingTokens(tmpl, ctx);
    expect(missing).toContain("{{candidate.email}}");
    expect(missing).toContain("{{client.name}}");
    expect(missing.filter((t) => t === "{{candidate.email}}")).toHaveLength(1);
  });

  it("getMissingTokens ignores unknown tokens", () => {
    const missing = getMissingTokens("{{unknown.token}} {{candidate.name}}", { candidate: { name: "Jo" } });
    expect(missing).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════
// CRUD + role guards
// ═════════════════════════════════════════════════════════════════
describe("CRUD + role guards", () => {
  let templateId: string;

  it("owner can create a template (201)", async () => {
    const res = await request(BASE)
      .post("/api/email-templates")
      .set("Cookie", ownerCookie)
      .send({
        name: "CRUD Test Template",
        subject: "Hi {{candidate.firstName}}",
        body: "You're great at {{candidate.currentTitle}}. Best, {{recruiter.name}}",
        category: "outreach",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe("CRUD Test Template");
    expect(res.body.isArchived).toBe(false);
    templateId = res.body.id as string;
  });

  it("GET lists active templates", async () => {
    const res = await request(BASE)
      .get("/api/email-templates")
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    const ids = (res.body.templates as { id: string }[]).map((t) => t.id);
    expect(ids).toContain(templateId);
  });

  it("owner can PATCH template fields", async () => {
    const res = await request(BASE)
      .patch(`/api/email-templates/${templateId}`)
      .set("Cookie", ownerCookie)
      .send({ name: "CRUD Test Template \u2014 Updated", category: "screening" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("CRUD Test Template \u2014 Updated");
    expect(res.body.category).toBe("screening");
  });

  it("owner can DELETE (archive) template, excluded from default list, visible with ?archived=true", async () => {
    const delRes = await request(BASE)
      .delete(`/api/email-templates/${templateId}`)
      .set("Cookie", ownerCookie);
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    const listRes = await request(BASE)
      .get("/api/email-templates")
      .set("Cookie", ownerCookie);
    const activeIds = (listRes.body.templates as { id: string }[]).map((t) => t.id);
    expect(activeIds).not.toContain(templateId);

    const archivedRes = await request(BASE)
      .get("/api/email-templates?archived=true")
      .set("Cookie", ownerCookie);
    const archivedIds = (archivedRes.body.templates as { id: string }[]).map((t) => t.id);
    expect(archivedIds).toContain(templateId);
  });

  it("recruiter gets 403 on POST", async () => {
    const res = await request(BASE)
      .post("/api/email-templates")
      .set("Cookie", recruiterCookie)
      .send({ name: "Should fail", subject: "Sub", body: "Body", category: "other" });
    expect(res.status).toBe(403);
  });

  it("recruiter gets 403 on PATCH", async () => {
    const res = await request(BASE)
      .patch(`/api/email-templates/${templateId}`)
      .set("Cookie", recruiterCookie)
      .send({ name: "Hacked" });
    expect(res.status).toBe(403);
  });

  it("recruiter gets 403 on DELETE", async () => {
    const res = await request(BASE)
      .delete(`/api/email-templates/${templateId}`)
      .set("Cookie", recruiterCookie);
    expect(res.status).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════
// RLS isolation
// ═════════════════════════════════════════════════════════════════
describe("RLS isolation", () => {
  it("blocks cross-workspace reads", async () => {
    const createRes = await request(BASE)
      .post("/api/email-templates")
      .set("Cookie", ownerCookie)
      .send({ name: "WS-A only template", subject: "Hello", body: "Hi there", category: "outreach" });
    expect(createRes.status).toBe(201);
    const templateId: string = createRes.body.id;

    const listRes = await request(BASE)
      .get("/api/email-templates")
      .set("Cookie", altOwnerCookie);
    expect(listRes.status).toBe(200);
    const ids = (listRes.body.templates as { id: string }[]).map((t) => t.id);
    expect(ids).not.toContain(templateId);
  });

  it("blocks cross-workspace render (template in A, requested by B)", async () => {
    const createRes = await request(BASE)
      .post("/api/email-templates")
      .set("Cookie", ownerCookie)
      .send({ name: "A-only render test", subject: "Subj", body: "Body", category: "other" });
    expect(createRes.status).toBe(201);
    const templateId: string = createRes.body.id;

    const renderRes = await request(BASE)
      .post(`/api/email-templates/${templateId}/render`)
      .set("Cookie", altOwnerCookie)
      .send({ candidateId });
    expect(renderRes.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════
// Render endpoint
// ═════════════════════════════════════════════════════════════════
describe("render endpoint", () => {
  let renderTemplateId: string;

  beforeAll(async () => {
    const res = await request(BASE)
      .post("/api/email-templates")
      .set("Cookie", ownerCookie)
      .send({
        name: "Render Test Template",
        subject: "Hi {{candidate.firstName}}, we have a {{job.title}} role",
        body: "Dear {{candidate.name}},\n\nRole: {{job.title}} at {{client.name}} ({{job.salaryRange}})\n\nBest,\n{{recruiter.name}}\n{{recruiter.email}}",
        category: "outreach",
      });
    expect(res.status).toBe(201);
    renderTemplateId = res.body.id as string;
  });

  it("hydrates subject + body with full context (candidateId + jobId)", async () => {
    const res = await request(BASE)
      .post(`/api/email-templates/${renderTemplateId}/render`)
      .set("Cookie", ownerCookie)
      .send({ candidateId, jobId });

    expect(res.status).toBe(200);
    expect(res.body.subject).toBe("Hi Alex, we have a Senior Backend Engineer role");
    expect(res.body.body).toContain("Dear Alex Rivera");
    expect(res.body.body).toContain("Senior Backend Engineer at Beta Inc");
    expect(res.body.body).toContain("$180,000");
    expect(res.body.missingTokens).toEqual([]);
  });

  it("reports missingTokens when no jobId provided", async () => {
    const res = await request(BASE)
      .post(`/api/email-templates/${renderTemplateId}/render`)
      .set("Cookie", ownerCookie)
      .send({ candidateId });

    expect(res.status).toBe(200);
    expect(res.body.missingTokens).toContain("{{job.title}}");
    expect(res.body.missingTokens).toContain("{{client.name}}");
    expect(res.body.missingTokens).toContain("{{job.salaryRange}}");
  });

  it("returns 404 for cross-workspace candidate (RLS isolation)", async () => {
    // Create template in workspace B, then try to render with workspace A's candidateId
    const tmplRes = await request(BASE)
      .post("/api/email-templates")
      .set("Cookie", altOwnerCookie)
      .send({ name: "B template", subject: "Hello {{candidate.name}}", body: "Hi", category: "other" });
    expect(tmplRes.status).toBe(201);
    const bTemplateId: string = tmplRes.body.id;

    const res = await request(BASE)
      .post(`/api/email-templates/${bTemplateId}/render`)
      .set("Cookie", altOwnerCookie)
      .send({ candidateId }); // candidateId belongs to workspace A → RLS blocks
    expect(res.status).toBe(404);
  });

  it("returns 404 for archived template", async () => {
    const createRes = await request(BASE)
      .post("/api/email-templates")
      .set("Cookie", ownerCookie)
      .send({ name: "To archive", subject: "Subj", body: "Body", category: "other" });
    expect(createRes.status).toBe(201);
    const id: string = createRes.body.id;

    await request(BASE).delete(`/api/email-templates/${id}`).set("Cookie", ownerCookie);

    const res = await request(BASE)
      .post(`/api/email-templates/${id}/render`)
      .set("Cookie", ownerCookie)
      .send({ candidateId });
    expect(res.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════
// Render → Compose E2E
// ═════════════════════════════════════════════════════════════════
describe("render → compose E2E", () => {
  it("hydrated subject+body flow into compose endpoint (409 grant_missing expected without connected inbox)", async () => {
    const tmplRes = await request(BASE)
      .post("/api/email-templates")
      .set("Cookie", ownerCookie)
      .send({
        name: "E2E Outreach",
        subject: "Hi {{candidate.firstName}}",
        body: "Reaching out about {{job.title}}. Best, {{recruiter.name}}",
        category: "outreach",
      });
    expect(tmplRes.status).toBe(201);
    const tmplId: string = tmplRes.body.id;

    const renderRes = await request(BASE)
      .post(`/api/email-templates/${tmplId}/render`)
      .set("Cookie", ownerCookie)
      .send({ candidateId, jobId });
    expect(renderRes.status).toBe(200);
    const { subject, body } = renderRes.body as { subject: string; body: string; missingTokens: string[] };
    expect(subject).toContain("Alex");
    expect(body).toContain("Senior Backend Engineer");

    // Send via compose — no connected inbox → 409 grant_missing
    const composeRes = await request(BASE)
      .post(`/api/candidates/${candidateId}/email/compose`)
      .set("Cookie", ownerCookie)
      .send({ to: "alex@example.com", subject, body });
    expect(composeRes.status).toBe(409);
    expect(composeRes.body.code).toBe("grant_missing");
  });
});
