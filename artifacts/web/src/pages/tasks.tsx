import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, AlertCircle, User2 } from "lucide-react";
import { formatDistanceToNow, isPast, isToday, format } from "date-fns";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Task = {
  id: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  completedAt: string | null;
  candidateId: string | null;
  createdAt: string | null;
};

type Groups = {
  overdue: Task[];
  today: Task[];
  this_week: Task[];
  later: Task[];
  completed: Task[];
};

async function fetchTasks(): Promise<{ groups: Groups; hasOverdue: boolean }> {
  const r = await fetch(`${BASE}/api/tasks`);
  if (!r.ok) throw new Error("Failed to load tasks");
  return r.json();
}

async function createTask(data: {
  title: string;
  dueAt?: string;
  description?: string;
}): Promise<Task> {
  const r = await fetch(`${BASE}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error("Failed to create task");
  return r.json();
}

async function completeTask(id: string): Promise<void> {
  const r = await fetch(`${BASE}/api/tasks/${id}/complete`, { method: "POST" });
  if (!r.ok) throw new Error("Failed to complete task");
}

function DueLabel({ dueAt }: { dueAt: string | null }) {
  if (!dueAt) return <span className="text-xs text-muted-foreground">No due date</span>;
  const d = new Date(dueAt);
  const overdue = isPast(d) && !isToday(d);
  return (
    <span className={cn("text-xs", overdue ? "text-destructive font-medium" : "text-muted-foreground")}>
      {overdue ? "Overdue · " : ""}
      {format(d, "MMM d")}
    </span>
  );
}

function TaskItem({
  task,
  onComplete,
  onNavigate,
}: {
  task: Task;
  onComplete: (id: string) => void;
  onNavigate: (id: string) => void;
}) {
  return (
    <li className="flex items-start gap-3 py-3 px-1">
      <Checkbox
        checked={!!task.completedAt}
        disabled={!!task.completedAt}
        onCheckedChange={() => onComplete(task.id)}
        className="mt-0.5"
      />
      <div className="flex-1 min-w-0">
        <p className={cn("text-sm font-medium", task.completedAt && "line-through text-muted-foreground")}>
          {task.title}
        </p>
        {task.description && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{task.description}</p>
        )}
        <div className="flex items-center gap-2 mt-1">
          <DueLabel dueAt={task.dueAt} />
          {task.candidateId && (
            <button
              className="text-xs text-primary underline-offset-2 hover:underline flex items-center gap-0.5"
              onClick={() => onNavigate(task.candidateId!)}
            >
              <User2 className="h-3 w-3" />
              View candidate
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function Section({ title, tasks, badge, onComplete, onNavigate }: {
  title: string;
  tasks: Task[];
  badge?: React.ReactNode;
  onComplete: (id: string) => void;
  onNavigate: (id: string) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
        {badge}
      </div>
      <ul className="divide-y">
        {tasks.map((t) => (
          <TaskItem key={t.id} task={t} onComplete={onComplete} onNavigate={onNavigate} />
        ))}
      </ul>
    </div>
  );
}

function CreateTaskDialog({ onCreated }: { onCreated: () => void }) {
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
      await createTask({ title, dueAt: dueAt || undefined, description: description || undefined });
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
        <Button size="sm"><Plus className="h-4 w-4 mr-1" />New task</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create task</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label htmlFor="title">Title</Label>
            <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="desc">Description</Label>
            <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="due">Due date</Label>
            <Input id="due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function TasksPage() {
  const [, navigate] = useLocation();
  const [groups, setGroups] = useState<Groups | null>(null);
  const [hasOverdue, setHasOverdue] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await fetchTasks();
      setGroups(data.groups);
      setHasOverdue(data.hasOverdue);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => { void load(); }, []);

  const handleComplete = async (id: string) => {
    await completeTask(id);
    await load();
  };

  const handleNavigate = (candidateId: string) => {
    navigate(`/candidates/${candidateId}`);
  };

  if (error) return <p className="text-destructive p-8">{error}</p>;
  if (!groups) return <p className="text-muted-foreground p-8">Loading…</p>;

  const total =
    groups.overdue.length +
    groups.today.length +
    groups.this_week.length +
    groups.later.length;

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">My Tasks</h1>
          {total === 0 && groups.completed.length === 0 && (
            <p className="text-muted-foreground text-sm mt-1">Nothing here yet</p>
          )}
        </div>
        <CreateTaskDialog onCreated={load} />
      </div>

      {groups.overdue.length > 0 && (
        <Section
          title="Overdue"
          tasks={groups.overdue}
          badge={
            <Badge variant="destructive" className="text-xs flex items-center gap-0.5">
              <AlertCircle className="h-3 w-3" />
              {groups.overdue.length}
            </Badge>
          }
          onComplete={handleComplete}
          onNavigate={handleNavigate}
        />
      )}
      <Section title="Today" tasks={groups.today} onComplete={handleComplete} onNavigate={handleNavigate} />
      <Section title="This Week" tasks={groups.this_week} onComplete={handleComplete} onNavigate={handleNavigate} />
      <Section title="Later" tasks={groups.later} onComplete={handleComplete} onNavigate={handleNavigate} />
      <Section title="Completed" tasks={groups.completed.slice(0, 20)} onComplete={handleComplete} onNavigate={handleNavigate} />
    </div>
  );
}
