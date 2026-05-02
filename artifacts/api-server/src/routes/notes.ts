/**
 * Notes API — CRUD for candidate notes with @mention support.
 *
 * Storage format: body_html stores Tiptap JSON serialized as a JSON string.
 * Render client-side with Tiptap's generateHTML(). This avoids XSS risk
 * from storing raw HTML server-side.
 *
 * mentioned_user_ids is extracted server-side from the Tiptap JSON tree;
 * any client-supplied list is ignored.
 *
 * On note save, notifications are inserted for each mentioned user.
 * Postmark email is stubbed: logs "[POSTMARK STUB] would send email to X".
 */
import { randomUUID } from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  notesTable,
  notificationsTable,
  activitiesTable,
  candidatesTable,
  usersTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";
import { withAudit } from "@workspace/audit";
import { logger } from "../lib/logger";
import { inngest } from "../lib/inngest";

const router: IRouter = Router();

// ── Tiptap JSON helpers ───────────────────────────────────────────────────

type TiptapNode = {
  type: string;
  text?: string;
  content?: TiptapNode[];
  attrs?: Record<string, unknown>;
};

/** Extract @mention user IDs from Tiptap JSON tree (server-side, never trusts client list). */
function extractMentionedUserIds(doc: TiptapNode): string[] {
  const ids = new Set<string>();
  function walk(node: TiptapNode) {
    if (node.type === "mention" && typeof node.attrs?.id === "string") {
      ids.add(node.attrs.id);
    }
    node.content?.forEach(walk);
  }
  walk(doc);
  return [...ids];
}

/** Flatten Tiptap JSON to plain text for body_plain / notifications snippets. */
function extractPlainText(doc: TiptapNode): string {
  const parts: string[] = [];
  function walk(node: TiptapNode) {
    if (node.type === "text") parts.push(node.text ?? "");
    else if (node.type === "mention") parts.push(`@${node.attrs?.label ?? node.attrs?.id ?? ""}`);
    node.content?.forEach(walk);
    if (["paragraph", "heading", "listItem", "blockquote"].includes(node.type)) {
      parts.push("\n");
    }
  }
  walk(doc);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

// ── GET /api/candidates/:id/notes ─────────────────────────────────────────

router.get("/candidates/:candidateId/notes", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;
  const candidateId = String(req.params.candidateId);

  const [candidate] = await txDb
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(and(eq(candidatesTable.id, candidateId), eq(candidatesTable.workspaceId, user.workspaceId)));

  if (!candidate) {
    res.status(404).json({ error: "Candidate not found" });
    return;
  }

  const notes = await txDb
    .select({
      id: notesTable.id,
      bodyHtml: notesTable.bodyHtml,
      bodyPlain: notesTable.bodyPlain,
      mentionedUserIds: notesTable.mentionedUserIds,
      authorId: notesTable.authorId,
      createdAt: notesTable.createdAt,
      updatedAt: notesTable.updatedAt,
    })
    .from(notesTable)
    .where(and(eq(notesTable.candidateId, candidateId), eq(notesTable.workspaceId, user.workspaceId)));

  // Enrich with author name
  const authorIds = [...new Set(notes.map((n) => n.authorId).filter(Boolean))];
  const authors =
    authorIds.length > 0
      ? await txDb.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email }).from(usersTable)
      : [];
  const authorMap = new Map(authors.map((a) => [a.id, a]));

  res.json({
    notes: notes.map((n) => ({
      ...n,
      author: authorMap.get(n.authorId) ?? null,
      createdAt: n.createdAt?.toISOString() ?? null,
      updatedAt: n.updatedAt?.toISOString() ?? null,
    })),
  });
});

// ── POST /api/candidates/:id/notes ────────────────────────────────────────

router.post("/candidates/:candidateId/notes", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;
  const candidateId = String(req.params.candidateId);

  const [candidate] = await txDb
    .select({ id: candidatesTable.id, name: candidatesTable.name })
    .from(candidatesTable)
    .where(and(eq(candidatesTable.id, candidateId), eq(candidatesTable.workspaceId, user.workspaceId)));

  if (!candidate) {
    res.status(404).json({ error: "Candidate not found" });
    return;
  }

  const { bodyJson } = req.body as { bodyJson?: unknown };
  if (!bodyJson || typeof bodyJson !== "object") {
    res.status(400).json({ error: "bodyJson (Tiptap document JSON) is required" });
    return;
  }

  const doc = bodyJson as TiptapNode;
  const mentionedUserIds = extractMentionedUserIds(doc);
  const bodyPlain = extractPlainText(doc);
  const bodyHtml = JSON.stringify(doc); // stored as JSON string

  const [note] = await withAudit(
    txDb,
    { workspaceId: user.workspaceId, action: "note.create", targetType: "note", userId: user.id },
    () =>
      txDb
        .insert(notesTable)
        .values({
          workspaceId: user.workspaceId,
          candidateId,
          authorId: user.id,
          bodyHtml,
          bodyPlain,
          mentionedUserIds: mentionedUserIds as `${string}-${string}-${string}-${string}-${string}`[],
        })
        .returning(),
  );

  // Activity row
  await txDb.insert(activitiesTable).values({
    workspaceId: user.workspaceId,
    candidateId,
    userId: user.id,
    type: "note.created",
    payload: { note_id: note.id },
  });

  // Notifications + Postmark stub for each mentioned user
  if (mentionedUserIds.length > 0) {
    const mentionedUsers = await txDb
      .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.workspaceId, user.workspaceId));

    const mentionedSet = new Set(mentionedUserIds);
    const toNotify = mentionedUsers.filter((u) => mentionedSet.has(u.id) && u.id !== user.id);

    const mentionerName =
      [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      user.email ||
      "Someone";

    for (const recipient of toNotify) {
      // Generate UUID client-side to avoid RETURNING filtered by recipient-scoped RLS SELECT policy
      const notifId = randomUUID() as `${string}-${string}-${string}-${string}-${string}`;

      await txDb.insert(notificationsTable).values({
        id: notifId,
        workspaceId: user.workspaceId,
        recipientId: recipient.id,
        type: "note.mention",
        payload: {
          note_id: note.id,
          candidate_id: candidateId,
          author_id: user.id,
          snippet: bodyPlain.slice(0, 200),
        },
      });

      try {
        await inngest.send({
          name: "email.mention",
          data: {
            notificationId: notifId,
            mentionerUserId: user.id,
            recipientUserId: recipient.id,
            candidateId,
            noteId: note.id,
            workspaceId: user.workspaceId,
            candidateName: candidate.name,
            mentionerName,
            recipientEmail: recipient.email ?? "",
            recipientName: recipient.name ?? recipient.email ?? "Teammate",
          },
        });
      } catch (err) {
        logger.warn({ err, recipientId: recipient.id }, "Failed to fire email.mention Inngest event — notification still written");
      }
    }
  }

  res.status(201).json({
    ...note,
    createdAt: note.createdAt?.toISOString() ?? null,
    updatedAt: note.updatedAt?.toISOString() ?? null,
  });
});

// ── PATCH /api/notes/:id ──────────────────────────────────────────────────

router.patch("/notes/:id", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;
  const noteId = String(req.params.id);

  const [existing] = await txDb
    .select()
    .from(notesTable)
    .where(and(eq(notesTable.id, noteId), eq(notesTable.workspaceId, user.workspaceId)));

  if (!existing) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  if (existing.authorId !== user.id) {
    res.status(403).json({ error: "Only the author can edit a note" });
    return;
  }

  const { bodyJson } = req.body as { bodyJson?: unknown };
  if (!bodyJson || typeof bodyJson !== "object") {
    res.status(400).json({ error: "bodyJson is required" });
    return;
  }

  const doc = bodyJson as TiptapNode;
  const mentionedUserIds = extractMentionedUserIds(doc);
  const bodyPlain = extractPlainText(doc);
  const bodyHtml = JSON.stringify(doc);

  const [updated] = await withAudit(
    txDb,
    { workspaceId: user.workspaceId, action: "note.update", targetType: "note", targetId: noteId, userId: user.id },
    () =>
      txDb
        .update(notesTable)
        .set({
          bodyHtml,
          bodyPlain,
          mentionedUserIds: mentionedUserIds as `${string}-${string}-${string}-${string}-${string}`[],
          updatedAt: new Date(),
        })
        .where(eq(notesTable.id, noteId))
        .returning(),
  );

  res.json({
    ...updated,
    createdAt: updated.createdAt?.toISOString() ?? null,
    updatedAt: updated.updatedAt?.toISOString() ?? null,
  });
});

// ── DELETE /api/notes/:id ─────────────────────────────────────────────────

router.delete("/notes/:id", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;
  const noteId = String(req.params.id);

  const [existing] = await txDb
    .select()
    .from(notesTable)
    .where(and(eq(notesTable.id, noteId), eq(notesTable.workspaceId, user.workspaceId)));

  if (!existing) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  if (existing.authorId !== user.id) {
    res.status(403).json({ error: "Only the author can delete a note" });
    return;
  }

  await withAudit(
    txDb,
    { workspaceId: user.workspaceId, action: "note.delete", targetType: "note", targetId: noteId, userId: user.id },
    () => txDb.delete(notesTable).where(eq(notesTable.id, noteId)),
  );

  res.json({ ok: true });
});

// ── GET /api/workspace/users (for @mention dropdown) ─────────────────────

router.get("/workspace/users", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const users = await txDb
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.workspaceId, user.workspaceId));

  res.json({ users });
});

export default router;
