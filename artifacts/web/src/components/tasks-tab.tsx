/**
 * Tasks tab on the candidate detail page.
 * Shows tasks linked to this candidate, ordered by due date.
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Loader2 } from "lucide-react";
import { format, isPast, isToday } from "date-fns";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Task = {
  id: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
};

async function fetchCandidateTasks(candidateId: string): Promise<Task[]> {
  const r = await fetch(`${BASE}/api/candidates/${candidateId}/tasks`);
  if (!r.ok) throw new Error("Failed to load tasks");
  const data = await r.json() as { tasks: Task[] };
  return data.tasks;
}

async function createTask(candidateId: string, data: {
  title: string;
  dueAt?: string;
  description?: string;
}): Promise<Task> {
  const r = await fetch(`${BASE}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...data, candidateId }),
  });
  if (!r.ok) throw new Error("Failed to create task");
  return r.json();
}

async function completeTask(id: string): Promise<void> {
  await fetch(`${BASE}/api/tasks/${id}/complete`, { method: "POST" });
}

async function deleteTask(id: string): Promise<void> {
  await fetch(`${BASE}/api/tasks/${id}`, { method: "DELETE" });
}

function TaskRow({
  task,
  onComplete,
  onDelete,
}: {
  task: Task;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const overdue = task.dueAt && !task.completedAt && isPast(new Date(task.dueAt)) && !isToday(new Date(task.dueAt));

  return (
    <li className="flex items-start gap-3 py-2.5">
      <Checkbox
        checked={!!task.completedAt}
        disabled={!!task.completedAt}
        onCheckedChange={() => onComplete(task.id)}
        className="mt-0.5"
      />
      <div className="flex-1 min-w-0">
        <p className={cn("text-sm", task.completedAt && "line-through text-muted-foreground")}>
          {task.title}
        </p>
        {task.description && (
          <p className="text-xs text-muted-foreground truncate">{task.description}</p>
        )}
        {task.dueAt && (
          <p className={cn("text-xs mt-0.5", overdue ? "text-destructive" : "text-muted-foreground")}>
            {overdue ? "Overdue · " : "Due "}
            {format(new Date(task.dueAt), "MMM d, yyyy")}
          </p>
        )}
      </div>
      {!task.completedAt && (
        <button
          className="text-muted-foreground hover:text-destructive shrink-0 text-xs"
          onClick={() => onDelete(task.id)}
        >
          ×
        </button>
      )}
    </li>
  );
}

function AddTaskDialog({ candidateId, onCreated }: { candidateId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setLoading(true);
    try {
      await createTask(candidateId, {
        title,
        dueAt: dueAt || undefined,
        description: description || undefined,
      });
      setOpen(false);
      setTitle(""); setDueAt(""); setDescription("");
      onCreated();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="h-3.5 w-3.5 mr-1" />New task
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add task</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-desc">Description</Label>
            <Input id="task-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-due">Due date</Label>
            <Input id="task-due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TasksTab({ candidateId }: { candidateId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await fetchCandidateTasks(candidateId);
      setTasks(data);
    } finally {
      setLoading(false);
    }
  }, [candidateId]);

  useEffect(() => { void load(); }, [load]);

  const handleComplete = async (id: string) => {
    await completeTask(id);
    await load();
  };

  const handleDelete = async (id: string) => {
    await deleteTask(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
  };

  if (loading) return <p className="text-muted-foreground py-4 text-sm">Loading tasks…</p>;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <AddTaskDialog candidateId={candidateId} onCreated={load} />
      </div>
      {tasks.length === 0 ? (
        <p className="text-center text-muted-foreground py-8 text-sm">No tasks linked to this candidate</p>
      ) : (
        <ul className="divide-y">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} onComplete={handleComplete} onDelete={handleDelete} />
          ))}
        </ul>
      )}
    </div>
  );
}
