/**
 * tests/dedup/email-match.test.ts
 *
 * Verifies 409 dedup conflict on matching email (case-insensitive).
 * Also verifies force=true bypasses the check.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestTenant, cleanTestData, pool } from "../helpers/db";

const BASE = process.env.API_BASE_URL ?? "http://localhost:80";
const PREFIX = "dedup-email";

let workspaceId: string;
let userId: string;
let cookie: string;

beforeAll(async () => {
  const t = await createTestTenant(PREFIX, "1");
  workspaceId = t.workspaceId;
  userId = t.userId;
  const s = await request(BASE).post("/api/_test/session").send({ workspaceId, userId });
  cookie = s.headers["set-cookie"]?.[0] ?? "";

  // Seed an existing candidate with a known email
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    await c.query(
      `INSERT INTO candidates (workspace_id, name, emails)
       VALUES ($1, 'Existing Candidate', ARRAY['dup@example.com']::text[])`,
      [workspaceId],
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}, 30_000);

afterAll(async () => {
  await cleanTestData(PREFIX);
  await pool.end();
});

describe("Email deduplication", () => {
  it("returns 409 when creating candidate with duplicate email", async () => {
    const r = await request(BASE)
      .post("/api/candidates")
      .set("Cookie", cookie)
      .send({ name: "New Candidate", emails: ["dup@example.com"] });
    expect(r.status).toBe(409);
    expect(r.body.duplicates).toHaveLength(1);
    expect(r.body.duplicates[0].name).toBe("Existing Candidate");
  });

  it("is case-insensitive (DUP@EXAMPLE.COM)", async () => {
    const r = await request(BASE)
      .post("/api/candidates")
      .set("Cookie", cookie)
      .send({ name: "Case Test", emails: ["DUP@EXAMPLE.COM"] });
    expect(r.status).toBe(409);
  });

  it("allows creation with force=true even when duplicate exists", async () => {
    const r = await request(BASE)
      .post("/api/candidates")
      .set("Cookie", cookie)
      .send({ name: "Force Created", emails: ["dup@example.com"], force: true });
    expect(r.status).toBe(201);
    expect(r.body.id).toBeTruthy();
  });

  it("allows creation when email is unique", async () => {
    const r = await request(BASE)
      .post("/api/candidates")
      .set("Cookie", cookie)
      .send({ name: "Unique Candidate", emails: ["unique-xxx@example.com"] });
    expect(r.status).toBe(201);
  });

  it("other workspace does not see conflict", async () => {
    const t2 = await createTestTenant(PREFIX, "2");
    const s2 = await request(BASE)
      .post("/api/_test/session")
      .send({ workspaceId: t2.workspaceId, userId: t2.userId });
    const c2 = s2.headers["set-cookie"]?.[0] ?? "";

    const r = await request(BASE)
      .post("/api/candidates")
      .set("Cookie", c2)
      .send({ name: "Cross Tenant", emails: ["dup@example.com"] });
    expect(r.status).toBe(201);
  });
});
