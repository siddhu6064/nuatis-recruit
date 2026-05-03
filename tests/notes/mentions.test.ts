/**
 * tests/notes/mentions.test.ts
 *
 * Verifies:
 * - Note creation stores body + extracts mentions server-side
 * - Notifications created for mentioned users
 * - Author edit/delete works; other user cannot delete
 * - GET /api/candidates/:id/notes returns notes with author
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestTenant, cleanTestData, pool } from "../helpers/db";

const BASE = process.env.API_BASE_URL ?? "http://localhost:80";
const PREFIX = "notes-mentions";

let workspaceId: string;
let userId: string;
let userId2: string;
let cookie: string;
let cookie2: string;
let candidateId: string;

function tiptapDoc(text: string, mentionId?: string, mentionLabel?: string) {
  const content: object[] = [{ type: "text", text }];
  if (mentionId) {
    content.push({
      type: "mention",
      attrs: { id: mentionId, label: mentionLabel ?? "User" },
    });
  }
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

beforeAll(async () => {
  const t = await createTestTenant(PREFIX, "1");
  workspaceId = t.workspaceId;
  userId = t.userId;

  const s1 = await request(BASE).post("/api/_test/session").send({ workspaceId, userId });
  cookie = s1.headers["set-cookie"]?.[0] ?? "";

  // Create a second user in the same workspace
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query<{ id: string }>(
      `INSERT INTO users (workspace_id, external_auth_id, external_auth_provider, email, role)
       VALUES ($1, $2, 'test', $3, 'recruiter')
       RETURNING id`,
      [workspaceId, `${PREFIX}-user2`, `${PREFIX}+user2@test.invalid`],
    );
    userId2 = r.rows[0].id;

    const cr = await c.query<{ id: string }>(
      `INSERT INTO candidates (workspace_id, name, emails)
       VALUES ($1, $2, ARRAY[$3]::text[])
       RETURNING id`,
      [workspaceId, "Notes Candidate", `${PREFIX}+cand@test.invalid`],
    );
    candidateId = cr.rows[0].id;
    await c.query("COMMIT");
  } finally {
    c.release();
  }

  const s2 = await request(BASE).post("/api/_test/session").send({ workspaceId, userId: userId2 });
  cookie2 = s2.headers["set-cookie"]?.[0] ?? "";
}, 30_000);

afterAll(async () => {
  await cleanTestData(PREFIX);
});

describe("Notes API", () => {
  let noteId: string;

  it("creates a note and returns 201", async () => {
    const doc = tiptapDoc("Hello, check this candidate");
    const r = await request(BASE)
      .post(`/api/candidates/${candidateId}/notes`)
      .set("Cookie", cookie)
      .send({ bodyJson: doc });
    expect(r.status).toBe(201);
    expect(r.body.id).toBeTruthy();
    expect(r.body.bodyHtml).toBeTruthy();
    noteId = r.body.id;
  });

  it("GET /api/candidates/:id/notes returns the note", async () => {
    const r = await request(BASE)
      .get(`/api/candidates/${candidateId}/notes`)
      .set("Cookie", cookie);
    expect(r.status).toBe(200);
    expect(r.body.notes).toHaveLength(1);
    expect(r.body.notes[0].id).toBe(noteId);
  });

  it("creates a notification for mentioned user", async () => {
    const doc = tiptapDoc("FYI ", userId2, "User Two");
    const r = await request(BASE)
      .post(`/api/candidates/${candidateId}/notes`)
      .set("Cookie", cookie)
      .send({ bodyJson: doc });
    expect(r.status).toBe(201);

    // Check notification exists for user2
    const notifR = await request(BASE)
      .get("/api/notifications")
      .set("Cookie", cookie2);
    expect(notifR.status).toBe(200);
    expect(notifR.body.notifications.length).toBeGreaterThan(0);
    const mention = notifR.body.notifications.find(
      (n: { type: string }) => n.type === "note.mention",
    );
    expect(mention).toBeTruthy();
  });

  it("does NOT create notification for self-mention", async () => {
    const notifBefore = await request(BASE)
      .get("/api/notifications")
      .set("Cookie", cookie);
    const countBefore: number = notifBefore.body.unreadCount;

    const doc = tiptapDoc("I mentioned myself ", userId, "Self");
    await request(BASE)
      .post(`/api/candidates/${candidateId}/notes`)
      .set("Cookie", cookie)
      .send({ bodyJson: doc });

    const notifAfter = await request(BASE)
      .get("/api/notifications")
      .set("Cookie", cookie);
    expect(notifAfter.body.unreadCount).toBe(countBefore); // no new notif
  });

  it("PATCH /api/notes/:id — author can update", async () => {
    const newDoc = tiptapDoc("Updated note body");
    const r = await request(BASE)
      .patch(`/api/notes/${noteId}`)
      .set("Cookie", cookie)
      .send({ bodyJson: newDoc });
    expect(r.status).toBe(200);
  });

  it("PATCH /api/notes/:id — non-author gets 403", async () => {
    const r = await request(BASE)
      .patch(`/api/notes/${noteId}`)
      .set("Cookie", cookie2)
      .send({ bodyJson: tiptapDoc("Hack!") });
    expect(r.status).toBe(403);
  });

  it("DELETE /api/notes/:id — non-author gets 403", async () => {
    const r = await request(BASE)
      .delete(`/api/notes/${noteId}`)
      .set("Cookie", cookie2);
    expect(r.status).toBe(403);
  });

  it("DELETE /api/notes/:id — author can delete", async () => {
    const r = await request(BASE)
      .delete(`/api/notes/${noteId}`)
      .set("Cookie", cookie);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("GET /api/workspace/users returns users for mention dropdown", async () => {
    const r = await request(BASE)
      .get("/api/workspace/users")
      .set("Cookie", cookie);
    expect(r.status).toBe(200);
    expect(r.body.users.length).toBeGreaterThanOrEqual(2);
  });
});
