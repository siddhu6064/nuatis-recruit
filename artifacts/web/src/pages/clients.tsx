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
import { Building2, Plus } from "lucide-react";

type Client = {
  id: string;
  name: string;
  primaryContactName: string | null;
  contactEmail: string | null;
  createdAt: string | null;
  openJobCount: number;
};

function useClients() {
  return useQuery<{ clients: Client[] }>({
    queryKey: ["/api/clients"],
    queryFn: async () => {
      const res = await fetch("/api/clients", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch clients");
      return res.json();
    },
  });
}

export default function Clients() {
  const { isLoading, isAuthenticated, login } = useAuth();
  const { data, isLoading: clientsLoading } = useClients();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [primaryContactName, setPrimaryContactName] = useState("");

  useEffect(() => {
    if (!isLoading && !isAuthenticated) login();
  }, [isLoading, isAuthenticated, login]);

  const createClient = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/clients", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, contactEmail, primaryContactName }),
      });
      if (!res.ok) throw new Error((await res.json() as { error: string }).error);
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/clients"] });
      setOpen(false);
      setName(""); setContactEmail(""); setPrimaryContactName("");
      toast({ title: "Client created" });
    },
    onError: (e) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="min-h-screen flex items-center justify-center"><div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">Clients</h1>
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Add Client
          </Button>
        </div>

        {clientsLoading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Name</th>
                  <th className="text-left px-4 py-3 font-medium">Primary Contact</th>
                  <th className="text-left px-4 py-3 font-medium">Contact Email</th>
                  <th className="text-left px-4 py-3 font-medium text-right">Open Jobs</th>
                </tr>
              </thead>
              <tbody>
                {data?.clients.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No clients yet. Add your first client.</td></tr>
                )}
                {data?.clients.map((c) => (
                  <tr key={c.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link href={`/clients/${c.id}`} className="text-primary hover:underline font-medium flex items-center gap-2">
                        <Building2 className="w-4 h-4 text-muted-foreground" />{c.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{c.primaryContactName ?? "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{c.contactEmail ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{c.openJobCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Client</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Company Name *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" />
            </div>
            <div className="space-y-1">
              <Label>Primary Contact</Label>
              <Input value={primaryContactName} onChange={(e) => setPrimaryContactName(e.target.value)} placeholder="Jane Smith" />
            </div>
            <div className="space-y-1">
              <Label>Contact Email</Label>
              <Input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="jane@acme.com" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => createClient.mutate()} disabled={!name.trim() || createClient.isPending}>
              {createClient.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
