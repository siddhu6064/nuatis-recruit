/**
 * tests/dedup/phone-match.test.ts
 *
 * Verifies 409 dedup on normalized phone (last 10 digits after stripping non-digits).
 * +1 (555) 123-4567 == 5551234567 == 15551234567
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestTenant, cleanTestData, pool } from "../helpers/db";

const BASE = process.env.API_BASE_URL ?? "http://localhost:80";
const PREFIX = "dedup-phone";

let workspaceId: string;
let userId: string;
let cookie: string;

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
    await c.query(
      `INSERT INTO candidates (workspace_id, name, emails, phones)
       VALUES ($1, 'Phone Candidate', ARRAY['phone-dup@test.invalid']::text[], ARRAY['5551234567']::text[])`,
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

describe("Phone deduplication", () => {
  it("returns 409 for exact normalized phone match", async () => {
    const r = await request(BASE)
      .post("/api/candidates")
      .set("Cookie", cookie)
      .send({ name: "Dup Phone", emails: ["uniq1@test.invalid"], phones: ["5551234567"] });
    expect(r.status).toBe(409);
  });

  it("normalizes +1 country code", async () => {
    const r = await request(BASE)
      .post("/api/candidates")
      .set("Cookie", cookie)
      .send({ name: "Dup With +1", emails: ["uniq2@test.invalid"], phones: ["+15551234567"] });
    expect(r.status).toBe(409);
  });

  it("normalizes formatted phone: (555) 123-4567", async () => {
    const r = await request(BASE)
      .post("/api/candidates")
      .set("Cookie", cookie)
      .send({ name: "Dup Formatted", emails: ["uniq3@test.invalid"], phones: ["(555) 123-4567"] });
    expect(r.status).toBe(409);
  });

  it("allows creation when phone differs", async () => {
    const r = await request(BASE)
      .post("/api/candidates")
      .set("Cookie", cookie)
      .send({ name: "Unique Phone", emails: ["uniq4@test.invalid"], phones: ["5559999999"] });
    expect(r.status).toBe(201);
  });

  it("force=true bypasses phone dedup", async () => {
    const r = await request(BASE)
      .post("/api/candidates")
      .set("Cookie", cookie)
      .send({ name: "Force Phone", emails: ["uniq5@test.invalid"], phones: ["5551234567"], force: true });
    expect(r.status).toBe(201);
  });
});
