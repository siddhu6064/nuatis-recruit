/**
 * Tasks API
 *
 * GET  /api/tasks            — inbox for current user (grouped: today/week/later/overdue/completed)
 * POST /api/tasks            — create task
 * GET  /api/candidates/:id/tasks — tasks for a specific candidate
 * PATCH /api/tasks/:id       — update (title, due_at, assignee, description)
 * POST /api/tasks/:id/complete — mark complete
 * DELETE /api/tasks/:id      — delete
 */
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tasksTable,
  activitiesTable,
  candidatesTable,
} from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";
import { withAudit } from "@workspace/audit";

const router: IRouter = Router();

// ── Task grouping helper ──────────────────────────────────────────────────

type TaskRow = {
  id: string;
  workspaceId: string;
  candidateId: string | null;
  assigneeId: string;
  createdBy: string;
  title: string;
  description: string | null;
  dueAt: Date | null;
  completedAt: Date | null;
  createdAt: Date | null;
};

type TaskGroup = "overdue" | "today" | "this_week" | "later" | "completed";

function groupTask(task: TaskRow): TaskGroup {
  if (task.completedAt) return "completed";
  if (!task.dueAt) return "later";

  const now = new Date();
  const due = new Date(task.dueAt);

  if (due < now) return "overdue";

  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  if (due <= todayEnd) return "today";

  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + 7);
  if (due <= weekEnd) return "this_week";

  return "later";
}

function serializeTask(t: TaskRow) {
  return {
    ...t,
    dueAt: t.dueAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    createdAt: t.createdAt?.toISOString() ?? null,
  };
}

// ── GET /api/tasks ────────────────────────────────────────────────────────

router.get("/tasks", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const tasks = await txDb
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.workspaceId, user.workspaceId), eq(tasksTable.assigneeId, user.id)));

  const grouped: Record<TaskGroup, ReturnType<typeof serializeTask>[]> = {
    overdue: [],
    today: [],
    this_week: [],
    later: [],
    completed: [],
  };

  for (const t of tasks) {
    grouped[groupTask(t)].push(serializeTask(t));
  }

  // Sort each group
  grouped.overdue.sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  grouped.today.sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  grouped.this_week.sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  grouped.later.sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  grouped.completed.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

  const hasOverdue = grouped.overdue.length > 0;
  res.json({ groups: grouped, hasOverdue });
});

// ── POST /api/tasks ───────────────────────────────────────────────────────

router.post("/tasks", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const { title, description, dueAt, assigneeId, candidateId } = req.body as Record<
    string,
    string
  >;

  if (!title?.trim()) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  const effectiveAssignee = assigneeId ?? user.id;

  const [task] = await withAudit(
    txDb,
    { workspaceId: user.workspaceId, action: "task.create", targetType: "task", userId: user.id },
    () =>
      txDb
        .insert(tasksTable)
        .values({
          workspaceId: user.workspaceId,
          candidateId: candidateId ?? null,
          assigneeId: effectiveAssignee,
          createdBy: user.id,
          title: title.trim(),
          description: description ?? null,
          dueAt: dueAt ? new Date(dueAt) : null,
        })
        .returning(),
  );

  // Write activity if linked to a candidate
  if (task.candidateId) {
    await txDb.insert(activitiesTable).values({
      workspaceId: user.workspaceId,
      candidateId: task.candidateId,
      userId: user.id,
      type: "task.created",
      payload: { task_id: task.id, title: task.title },
    });
  }

  res.status(201).json(serializeTask(task));
});

// ── GET /api/candidates/:id/tasks ─────────────────────────────────────────

router.get("/candidates/:candidateId/tasks", async (req: Request, res: Response) => {
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

  const tasks = await txDb
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.candidateId, candidateId), eq(tasksTable.workspaceId, user.workspaceId)));

  // Sort: incomplete by due_at ASC, completed at the bottom
  const incomplete = tasks.filter((t) => !t.completedAt).sort((a, b) => {
    if (!a.dueAt && !b.dueAt) return 0;
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return a.dueAt.getTime() - b.dueAt.getTime();
  });
  const completed = tasks.filter((t) => t.completedAt);

  res.json({ tasks: [...incomplete, ...completed].map(serializeTask) });
});

// ── PATCH /api/tasks/:id ──────────────────────────────────────────────────

router.patch("/tasks/:id", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;
  const taskId = String(req.params.id);

  const [existing] = await txDb
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.id, taskId), eq(tasksTable.workspaceId, user.workspaceId)));

  if (!existing) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const { title, description, dueAt, assigneeId } = req.body as Record<string, string | null>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = {};
  if (title !== undefined) patch.title = String(title).trim();
  if (description !== undefined) patch.description = description;
  if (dueAt !== undefined) patch.dueAt = dueAt ? new Date(dueAt) : null;
  if (assigneeId !== undefined) patch.assigneeId = assigneeId;

  const [updated] = await withAudit(
    txDb,
    { workspaceId: user.workspaceId, action: "task.update", targetType: "task", targetId: taskId, userId: user.id },
    () => txDb.update(tasksTable).set(patch).where(eq(tasksTable.id, taskId)).returning(),
  );

  res.json(serializeTask(updated));
});

// ── POST /api/tasks/:id/complete ──────────────────────────────────────────

router.post("/tasks/:id/complete", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;
  const taskId = String(req.params.id);

  const [existing] = await txDb
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.id, taskId), eq(tasksTable.workspaceId, user.workspaceId)));

  if (!existing) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const completedAt = new Date();
  const [updated] = await withAudit(
    txDb,
    { workspaceId: user.workspaceId, action: "task.complete", targetType: "task", targetId: taskId, userId: user.id },
    () => txDb.update(tasksTable).set({ completedAt }).where(eq(tasksTable.id, taskId)).returning(),
  );

  if (existing.candidateId) {
    await txDb.insert(activitiesTable).values({
      workspaceId: user.workspaceId,
      candidateId: existing.candidateId,
      userId: user.id,
      type: "task.completed",
      payload: { task_id: taskId, title: existing.title },
    });
  }

  res.json(serializeTask(updated));
});

// ── DELETE /api/tasks/:id ─────────────────────────────────────────────────

router.delete("/tasks/:id", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;
  const taskId = String(req.params.id);

  const [existing] = await txDb
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(and(eq(tasksTable.id, taskId), eq(tasksTable.workspaceId, user.workspaceId)));

  if (!existing) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  await withAudit(
    txDb,
    { workspaceId: user.workspaceId, action: "task.delete", targetType: "task", targetId: taskId, userId: user.id },
    () => txDb.delete(tasksTable).where(eq(tasksTable.id, taskId)),
  );

  res.json({ ok: true });
});

// ── GET /api/tasks/overdue-count ──────────────────────────────────────────

router.get("/tasks/overdue-count", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const tasks = await txDb
    .select({ dueAt: tasksTable.dueAt, completedAt: tasksTable.completedAt })
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.workspaceId, user.workspaceId),
        eq(tasksTable.assigneeId, user.id),
        isNull(tasksTable.completedAt),
      ),
    );

  const now = new Date();
  const count = tasks.filter((t) => t.dueAt && new Date(t.dueAt) < now).length;
  res.json({ count });
});

export default router;
