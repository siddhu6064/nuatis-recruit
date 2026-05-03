/**
 * /settings/email-templates — per-workspace email template management.
 * Owner-only write access; recruiters see a permission notice.
 */
import { useState } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Nav } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Pencil, Archive, AlertCircle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const CATEGORY_OPTIONS = [
  { value: "outreach",   label: "Outreach" },
  { value: "screening",  label: "Screening" },
  { value: "interview",  label: "Interview" },
  { value: "offer",      label: "Offer" },
  { value: "rejection",  label: "Rejection" },
  { value: "follow_up",  label: "Follow-up" },
  { value: "other",      label: "Other" },
] as const;

type Category = (typeof CATEGORY_OPTIONS)[number]["value"];

type Template = {
  id: string;
  name: string;
  subject: string;
  body: string;
  category: Category;
  isArchived: boolean;
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
};

type FormState = {
  name: string;
  subject: string;
  body: string;
  category: Category;
};

const BLANK: FormState = { name: "", subject: "", body: "", category: "other" };

const MERGE_HINT = [
  "{{candidate.name}}",
  "{{candidate.firstName}}",
  "{{candidate.email}}",
  "{{candidate.currentTitle}}",
  "{{candidate.currentCompany}}",
  "{{candidate.location}}",
  "{{job.title}}",
  "{{job.location}}",
  "{{job.salaryRange}}",
  "{{client.name}}",
  "{{recruiter.name}}",
  "{{recruiter.email}}",
].join("  ");

export default function SettingsEmailTemplates() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const isOwner = user?.role === "owner";

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(BLANK);
  const [archiveTarget, setArchiveTarget] = useState<Template | null>(null);

  const { data, isLoading } = useQuery<{ templates: Template[] }>({
    queryKey: ["/api/email-templates"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/email-templates`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load templates");
      return r.json() as Promise<{ templates: Template[] }>;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (payload: FormState) => {
      const url = editingId
        ? `${BASE}/api/email-templates/${editingId}`
        : `${BASE}/api/email-templates`;
      const r = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const d = (await r.json()) as { error?: string };
        throw new Error(d.error ?? "Save failed");
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/email-templates"] });
      setModalOpen(false);
      setEditingId(null);
      setForm(BLANK);
      toast({ title: editingId ? "Template updated" : "Template created" });
    },
    onError: (err) => {
      toast({ title: "Error", description: String(err), variant: "destructive" });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`${BASE}/api/email-templates/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error("Archive failed");
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/email-templates"] });
      setArchiveTarget(null);
      toast({ title: "Template archived" });
    },
    onError: () => {
      toast({ title: "Error archiving template", variant: "destructive" });
    },
  });

  function openCreate() {
    setEditingId(null);
    setForm(BLANK);
    setModalOpen(true);
  }

  function openEdit(t: Template) {
    setEditingId(t.id);
    setForm({ name: t.name, subject: t.subject, body: t.body, category: t.category });
    setModalOpen(true);
  }

  const templates = data?.templates ?? [];

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold">Email Templates</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Reusable templates with merge fields for candidate outreach.
            </p>
          </div>
          {isOwner && (
            <Button onClick={openCreate} size="sm">
              <Plus className="h-4 w-4 mr-1.5" />
              New template
            </Button>
          )}
        </div>

        {!isOwner && (
          <div className="flex items-start gap-3 rounded-lg border p-4 bg-muted/40 mb-6">
            <AlertCircle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-sm text-muted-foreground">
              Only workspace owners can create or edit email templates.
            </p>
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground text-sm">
            {isOwner
              ? "No templates yet. Create your first template to get started."
              : "No templates have been created for this workspace."}
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Category</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Subject</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Updated</th>
                  {isOwner && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id} className="border-t hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 font-medium">{t.name}</td>
                    <td className="px-4 py-3 text-muted-foreground capitalize">
                      {t.category.replace("_", " ")}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground truncate max-w-[240px]">
                      {t.subject}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {t.updatedAt ? new Date(t.updatedAt).toLocaleDateString() : "—"}
                    </td>
                    {isOwner && (
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 justify-end">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEdit(t)}
                            className="h-7 w-7 p-0"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setArchiveTarget(t)}
                            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create / Edit modal */}
      <Dialog open={modalOpen} onOpenChange={(v) => { if (!v && !saveMutation.isPending) setModalOpen(false); }}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Template" : "New Template"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="tmpl-name">Name</Label>
                <Input
                  id="tmpl-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Initial outreach"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tmpl-category">Category</Label>
                <Select
                  value={form.category}
                  onValueChange={(v) => setForm((f) => ({ ...f, category: v as Category }))}
                >
                  <SelectTrigger id="tmpl-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tmpl-subject">Subject</Label>
              <Input
                id="tmpl-subject"
                value={form.subject}
                onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                placeholder="e.g. Exciting opportunity for {{candidate.firstName}}"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tmpl-body">Body</Label>
              <textarea
                id="tmpl-body"
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                rows={10}
                placeholder={"Hi {{candidate.firstName}},\n\nI came across your profile and thought you'd be a great fit for {{job.title}} at {{client.name}}.\n\nBest,\n{{recruiter.name}}"}
                className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono text-xs"
              />
            </div>

            <div className="rounded-md bg-muted/40 px-3 py-2">
              <p className="text-xs text-muted-foreground font-medium mb-1">Available merge fields</p>
              <p className="text-xs text-muted-foreground break-all leading-5">{MERGE_HINT}</p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setModalOpen(false)}
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              disabled={!form.name.trim() || !form.subject.trim() || !form.body.trim() || saveMutation.isPending}
              onClick={() => saveMutation.mutate(form)}
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : editingId ? "Save changes" : "Create template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive confirmation dialog */}
      <Dialog open={!!archiveTarget} onOpenChange={(v) => { if (!v) setArchiveTarget(null); }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Archive template?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-1">
            <span className="font-medium text-foreground">{archiveTarget?.name}</span> will be hidden
            from the template picker. This cannot be undone from the UI.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setArchiveTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={archiveMutation.isPending}
              onClick={() => archiveTarget && archiveMutation.mutate(archiveTarget.id)}
            >
              {archiveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
