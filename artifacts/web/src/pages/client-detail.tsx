import { useAuth } from "@workspace/replit-auth-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useParams } from "wouter";
import { Nav } from "@/components/nav";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Briefcase, Mail, Phone, User2 } from "lucide-react";

type Client = {
  id: string;
  name: string;
  primaryContactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contractTerms: string | null;
  createdAt: string | null;
};

type Job = {
  id: string;
  title: string;
  status: string;
  location: string | null;
  applicantCount: number;
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  open: "bg-emerald-50 text-emerald-700 border-emerald-200",
  on_hold: "bg-yellow-50 text-yellow-700 border-yellow-200",
  closed: "bg-red-50 text-red-600 border-red-200",
  filled: "bg-blue-50 text-blue-700 border-blue-200",
};

export default function ClientDetail() {
  const { isLoading, isAuthenticated, login } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  useEffect(() => {
    if (!isLoading && !isAuthenticated) login();
  }, [isLoading, isAuthenticated, login]);

  const { data: client, isLoading: clientLoading } = useQuery<Client>({
    queryKey: ["/api/clients", id],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch client");
      return res.json();
    },
    enabled: !!id,
  });

  const { data: jobsData, isLoading: jobsLoading } = useQuery<{ jobs: Job[] }>({
    queryKey: ["/api/jobs", id, ""],
    queryFn: async () => {
      const res = await fetch(`/api/jobs?client_id=${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch jobs");
      return res.json();
    },
    enabled: !!id,
  });

  if (isLoading) return <div className="min-h-screen flex items-center justify-center"><div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="max-w-5xl mx-auto px-6 py-8">
        <Link href="/clients" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="w-4 h-4" /> Clients
        </Link>

        {clientLoading ? (
          <div className="space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-5 w-40" /></div>
        ) : client ? (
          <>
            <div className="flex items-start justify-between mb-8">
              <div>
                <h1 className="text-2xl font-semibold">{client.name}</h1>
                <div className="flex flex-wrap gap-4 mt-2 text-sm text-muted-foreground">
                  {client.primaryContactName && (
                    <span className="flex items-center gap-1"><User2 className="w-4 h-4" />{client.primaryContactName}</span>
                  )}
                  {client.contactEmail && (
                    <a href={`mailto:${client.contactEmail}`} className="flex items-center gap-1 hover:text-foreground">
                      <Mail className="w-4 h-4" />{client.contactEmail}
                    </a>
                  )}
                  {client.contactPhone && (
                    <span className="flex items-center gap-1"><Phone className="w-4 h-4" />{client.contactPhone}</span>
                  )}
                </div>
              </div>
            </div>

            <h2 className="text-lg font-medium mb-3 flex items-center gap-2">
              <Briefcase className="w-5 h-5 text-muted-foreground" /> Linked Jobs
            </h2>
            {jobsLoading ? (
              <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium">Title</th>
                      <th className="text-left px-4 py-3 font-medium">Status</th>
                      <th className="text-left px-4 py-3 font-medium">Location</th>
                      <th className="text-right px-4 py-3 font-medium">Applicants</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobsData?.jobs.length === 0 && (
                      <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">No jobs for this client yet.</td></tr>
                    )}
                    {jobsData?.jobs.map((j) => (
                      <tr key={j.id} className="border-t hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <Link href={`/jobs/${j.id}`} className="text-primary hover:underline">{j.title}</Link>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className={`text-xs ${STATUS_COLORS[j.status] ?? ""}`}>
                            {j.status.replace("_", " ")}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{j.location ?? "—"}</td>
                        <td className="px-4 py-3 text-right">{j.applicantCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">Client not found.</p>
        )}
      </main>
    </div>
  );
}
