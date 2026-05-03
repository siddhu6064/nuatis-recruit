/**
 * tests/tasks/inbox.test.ts
 *
 * Verifies:
 * - Task create/complete/delete lifecycle
 * - Inbox grouping (overdue, today, this_week, later, completed)
 * - Candidate-linked task retrieval
 * - overdue-count endpoint
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestTenant, cleanTestData, pool } from "../helpers/db";

const BASE = process.env.API_BASE_URL ?? "http://localhost:80";
const PREFIX = "tasks-inbox";

let workspaceId: string;
let userId: string;
let cookie: string;
let candidateId: string;

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
    const cr = await c.query<{ id: string }>(
      `INSERT INTO candidates (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [workspaceId, "Task Candidate"],
    );
    candidateId = cr.rows[0].id;
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}, 30_000);

afterAll(async () => {
  await cleanTestData(PREFIX);
});

describe("Tasks inbox", () => {
  let overdueTaskId: string;
  let todayTaskId: string;
  let laterTaskId: string;
  let candidateTaskId: string;

  it("creates overdue task (due yesterday)", async () => {
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const r = await request(BASE)
      .post("/api/tasks")
      .set("Cookie", cookie)
      .send({ title: "Overdue task", dueAt: yesterday });
    expect(r.status).toBe(201);
    overdueTaskId = r.body.id;
  });

  it("creates today task", async () => {
    const todayNoon = new Date();
    todayNoon.setHours(23, 30, 0, 0);
    const r = await request(BASE)
      .post("/api/tasks")
      .set("Cookie", cookie)
      .send({ title: "Today task", dueAt: todayNoon.toISOString() });
    expect(r.status).toBe(201);
    todayTaskId = r.body.id;
  });

  it("creates later task (due in 14 days)", async () => {
    const later = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const r = await request(BASE)
      .post("/api/tasks")
      .set("Cookie", cookie)
      .send({ title: "Later task", dueAt: later });
    expect(r.status).toBe(201);
    laterTaskId = r.body.id;
  });

  it("creates candidate-linked task", async () => {
    const r = await request(BASE)
      .post("/api/tasks")
      .set("Cookie", cookie)
      .send({ title: "Follow up with candidate", candidateId });
    expect(r.status).toBe(201);
    candidateTaskId = r.body.id;
  });

  it("GET /api/tasks groups tasks correctly", async () => {
    const r = await request(BASE).get("/api/tasks").set("Cookie", cookie);
    expect(r.status).toBe(200);

    const { groups, hasOverdue } = r.body as {
      groups: { overdue: unknown[]; today: unknown[]; this_week: unknown[]; later: unknown[]; completed: unknown[] };
      hasOverdue: boolean;
    };

    expect(groups.overdue.length).toBeGreaterThan(0);
    expect(groups.today.length).toBeGreaterThan(0);
    expect(groups.later.length).toBeGreaterThan(0);
    expect(hasOverdue).toBe(true);
  });

  it("GET /api/tasks/overdue-count returns non-zero", async () => {
    const r = await request(BASE)
      .get("/api/tasks/overdue-count")
      .set("Cookie", cookie);
    expect(r.status).toBe(200);
    expect(r.body.count).toBeGreaterThan(0);
  });

  it("GET /api/candidates/:id/tasks returns candidate task", async () => {
    const r = await request(BASE)
      .get(`/api/candidates/${candidateId}/tasks`)
      .set("Cookie", cookie);
    expect(r.status).toBe(200);
    expect(r.body.tasks.some((t: { id: string }) => t.id === candidateTaskId)).toBe(true);
  });

  it("POST /api/tasks/:id/complete marks task done", async () => {
    const r = await request(BASE)
      .post(`/api/tasks/${overdueTaskId}/complete`)
      .set("Cookie", cookie);
    expect(r.status).toBe(200);
    expect(r.body.completedAt).toBeTruthy();
  });

  it("completed task appears in completed group", async () => {
    // Small delay to let the async res.on("finish") COMMIT become visible
    await new Promise((r) => setTimeout(r, 25));
    const r = await request(BASE).get("/api/tasks").set("Cookie", cookie);
    expect(r.status).toBe(200);
    const completed = r.body.groups.completed as { id: string }[];
    expect(completed.some((t) => t.id === overdueTaskId)).toBe(true);
  });

  it("PATCH /api/tasks/:id updates title and dueAt", async () => {
    const newDue = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const r = await request(BASE)
      .patch(`/api/tasks/${todayTaskId}`)
      .set("Cookie", cookie)
      .send({ title: "Updated title", dueAt: newDue });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe("Updated title");
  });

  it("DELETE /api/tasks/:id removes task", async () => {
    const r = await request(BASE)
      .delete(`/api/tasks/${laterTaskId}`)
      .set("Cookie", cookie);
    expect(r.status).toBe(200);
  });

  it("requires title on create", async () => {
    const r = await request(BASE)
      .post("/api/tasks")
      .set("Cookie", cookie)
      .send({ description: "no title" });
    expect(r.status).toBe(400);
  });
});
