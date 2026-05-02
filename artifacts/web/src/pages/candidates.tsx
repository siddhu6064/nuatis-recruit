import { useAuth } from "@workspace/replit-auth-web";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Nav } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { User2, Plus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

type Candidate = {
  id: string;
  name: string;
  currentTitle: string | null;
  source: string | null;
  lastActivityAt: string | null;
  createdAt: string | null;
};

export default function Candidates() {
  const { isLoading, isAuthenticated, login } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", emails: "", phones: "", currentTitle: "", currentCompany: "" });

  useEffect(() => {
    if (!isLoading && !isAuthenticated) login();
  }, [isLoading, isAuthenticated, login]);

  const { data, isLoading: loading } = useQuery<{ candidates: Candidate[] }>({
    queryKey: ["/api/candidates"],
    queryFn: async () => {
      const res = await fetch("/api/candidates", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch candidates");
      return res.json();
    },
  });

  const createCandidate = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/candidates", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          emails: form.emails ? [form.emails] : [],
          phones: form.phones ? [form.phones] : [],
        }),
      });
      if (!res.ok) throw new Error((await res.json() as { error: string }).error);
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/candidates"] });
      setOpen(false);
      setForm({ name: "", emails: "", phones: "", currentTitle: "", currentCompany: "" });
      toast({ title: "Candidate added" });
    },
    onError: (e) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="min-h-screen flex items-center justify-center"><div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">Candidates</h1>
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Add Candidate
          </Button>
        </div>

        {loading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Name</th>
                  <th className="text-left px-4 py-3 font-medium">Current Title</th>
                  <th className="text-left px-4 py-3 font-medium">Source</th>
                  <th className="text-left px-4 py-3 font-medium">Last Activity</th>
                </tr>
              </thead>
              <tbody>
                {data?.candidates.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No candidates yet.</td></tr>
                )}
                {data?.candidates.map((c) => (
                  <tr key={c.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link href={`/candidates/${c.id}`} className="text-primary hover:underline font-medium flex items-center gap-2">
                        <User2 className="w-4 h-4 text-muted-foreground" />{c.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{c.currentTitle ?? "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{c.source ?? "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {c.lastActivityAt ? formatDistanceToNow(new Date(c.lastActivityAt), { addSuffix: true }) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Candidate</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Full Name *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Alex Johnson" />
            </div>
            <div className="space-y-1">
              <Label>Email</Label>
              <Input type="email" value={form.emails} onChange={(e) => setForm({ ...form, emails: e.target.value })} placeholder="alex@example.com" />
            </div>
            <div className="space-y-1">
              <Label>Phone</Label>
              <Input value={form.phones} onChange={(e) => setForm({ ...form, phones: e.target.value })} placeholder="+1 555 000 0000" />
            </div>
            <div className="space-y-1">
              <Label>Current Title</Label>
              <Input value={form.currentTitle} onChange={(e) => setForm({ ...form, currentTitle: e.target.value })} placeholder="Senior Engineer" />
            </div>
            <div className="space-y-1">
              <Label>Current Company</Label>
              <Input value={form.currentCompany} onChange={(e) => setForm({ ...form, currentCompany: e.target.value })} placeholder="Acme Corp" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => createCandidate.mutate()} disabled={!form.name.trim() || createCandidate.isPending}>
              {createCandidate.isPending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
