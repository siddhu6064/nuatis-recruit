import { useAuth } from "@workspace/replit-auth-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useParams } from "wouter";
import { Nav } from "@/components/nav";
import { CommunicationsTab } from "@/components/communications-tab";
import { NotesTab } from "@/components/notes-tab";
import { TasksTab } from "@/components/tasks-tab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ArrowLeft, Mail, Phone, MapPin } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

type Candidate = {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  location: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  summary: string | null;
  source: string | null;
  doNotContact: boolean;
  lastActivityAt: string | null;
  createdAt: string | null;
};

type Application = {
  id: string;
  jobId: string;
  jobTitle: string | null;
  stage: string;
  source: string | null;
  appliedAt: string | null;
};

type MatchBreakdown = {
  skills: number;
  experience: number;
  seniority: number;
  location: number;
};

type MatchScore = {
  applicationId: string;
  score: number;
  breakdown: MatchBreakdown | null;
  rationale: string | null;
  evidenceQuotes: string[] | null;
  modelVersion: string | null;
};

function scoreBadgeClass(score: number): string {
  if (score >= 75) return "bg-emerald-100 text-emerald-800 border-emerald-300";
  if (score >= 50) return "bg-yellow-100 text-yellow-800 border-yellow-300";
  return "bg-red-100 text-red-800 border-red-300";
}

function MatchBadge({ ms }: { ms: MatchScore | undefined }) {
  if (!ms) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs border bg-muted text-muted-foreground">
        —
      </span>
    );
  }

  const bd = ms.breakdown;
  const quotes = ms.evidenceQuotes ?? [];

  return (
    <TooltipProvider>
      <Sheet>
        <Tooltip>
          <TooltipTrigger asChild>
            <SheetTrigger asChild>
              <button
                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border cursor-pointer hover:opacity-80 transition-opacity ${scoreBadgeClass(ms.score)}`}
              >
                {ms.score}
              </button>
            </SheetTrigger>
          </TooltipTrigger>
          <TooltipContent className="text-xs space-y-0.5 p-2">
            {bd ? (
              <>
                <p>Skills: {bd.skills}/40</p>
                <p>Experience: {bd.experience}/30</p>
                <p>Seniority: {bd.seniority}/20</p>
                <p>Location: {bd.location}/10</p>
              </>
            ) : (
              <p>Score: {ms.score}</p>
            )}
            <p className="text-muted-foreground mt-1">Click for details</p>
          </TooltipContent>
        </Tooltip>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Match Score: {ms.score}/100</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-4 text-sm">
            {bd && (
              <div className="space-y-2">
                <h4 className="font-medium text-muted-foreground uppercase text-xs tracking-wide">Breakdown</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-muted/40 rounded p-2">
                    <div className="text-xs text-muted-foreground">Skills (40%)</div>
                    <div className="font-semibold">{bd.skills}/40</div>
                  </div>
                  <div className="bg-muted/40 rounded p-2">
                    <div className="text-xs text-muted-foreground">Experience (30%)</div>
                    <div className="font-semibold">{bd.experience}/30</div>
                  </div>
                  <div className="bg-muted/40 rounded p-2">
                    <div className="text-xs text-muted-foreground">Seniority (20%)</div>
                    <div className="font-semibold">{bd.seniority}/20</div>
                  </div>
                  <div className="bg-muted/40 rounded p-2">
                    <div className="text-xs text-muted-foreground">Location (10%)</div>
                    <div className="font-semibold">{bd.location}/10</div>
                  </div>
                </div>
              </div>
            )}
            {ms.rationale && (
              <div>
                <h4 className="font-medium text-muted-foreground uppercase text-xs tracking-wide mb-1">Rationale</h4>
                <p className="text-muted-foreground">{ms.rationale}</p>
              </div>
            )}
            {quotes.length > 0 && (
              <div>
                <h4 className="font-medium text-muted-foreground uppercase text-xs tracking-wide mb-1">Evidence</h4>
                <ul className="space-y-1">
                  {quotes.map((q, i) => (
                    <li key={i} className="bg-muted/40 rounded px-2 py-1 italic text-muted-foreground">
                      "{q}"
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {ms.modelVersion && (
              <p className="text-xs text-muted-foreground">Model: {ms.modelVersion}</p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}

export default function CandidateDetail() {
  const { isLoading, isAuthenticated, login } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  useEffect(() => {
    if (!isLoading && !isAuthenticated) login();
  }, [isLoading, isAuthenticated, login]);

  const { data: candidate, isLoading: cLoading } = useQuery<Candidate>({
    queryKey: ["/api/candidates", id],
    queryFn: async () => {
      const res = await fetch(`/api/candidates/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch candidate");
      return res.json();
    },
    enabled: !!id,
  });

  const { data: workspaceData } = useQuery<{ emailV1Enabled: boolean }>({
    queryKey: ["/api/workspace"],
    queryFn: async () => {
      const res = await fetch("/api/workspace", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch workspace");
      return res.json();
    },
    enabled: isAuthenticated,
  });

  const { data: appsData, isLoading: appsLoading } = useQuery<{ applications: Application[] }>({
    queryKey: ["/api/applications/candidate", id],
    queryFn: async () => {
      const res = await fetch(`/api/applications?candidate_id=${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch applications");
      return res.json();
    },
    enabled: !!id,
  });

  // Poll match scores for all applications of this candidate every 3s
  const appIds = appsData?.applications.map((a) => a.id) ?? [];
  const { data: scoresMap } = useQuery<Map<string, MatchScore>>({
    queryKey: ["/api/match-scores/candidate", id, appIds.join(",")],
    queryFn: async () => {
      const map = new Map<string, MatchScore>();
      await Promise.all(
        appIds.map(async (appId) => {
          const res = await fetch(
            `/api/match-scores?application_id=${appId}`,
            { credentials: "include" },
          );
          if (!res.ok) return;
          const data = (await res.json()) as { matchScore: MatchScore | null };
          if (data.matchScore) map.set(appId, data.matchScore);
        }),
      );
      return map;
    },
    enabled: appIds.length > 0,
    refetchInterval: 3000,
  });

  if (isLoading) return <div className="min-h-screen flex items-center justify-center"><div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="max-w-5xl mx-auto px-6 py-8">
        <Link href="/candidates" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="w-4 h-4" /> Candidates
        </Link>

        {cLoading ? (
          <div className="space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-5 w-40" /></div>
        ) : candidate ? (
          <>
            <div className="mb-6">
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-2xl font-semibold">{candidate.name}</h1>
                {candidate.doNotContact && (
                  <Badge variant="destructive" className="text-xs">Do Not Contact</Badge>
                )}
              </div>
              {(candidate.currentTitle || candidate.currentCompany) && (
                <p className="text-muted-foreground">
                  {[candidate.currentTitle, candidate.currentCompany].filter(Boolean).join(" at ")}
                </p>
              )}
              <div className="flex flex-wrap gap-3 mt-2 text-sm text-muted-foreground">
                {candidate.emails?.map((e) => (
                  <a key={e} href={`mailto:${e}`} className="flex items-center gap-1 hover:text-foreground">
                    <Mail className="w-4 h-4" />{e}
                  </a>
                ))}
                {candidate.phones?.map((p) => (
                  <span key={p} className="flex items-center gap-1"><Phone className="w-4 h-4" />{p}</span>
                ))}
                {candidate.location && (
                  <span className="flex items-center gap-1"><MapPin className="w-4 h-4" />{candidate.location}</span>
                )}
              </div>
            </div>

            <Tabs defaultValue="profile">
              <TabsList>
                <TabsTrigger value="profile">Profile</TabsTrigger>
                <TabsTrigger value="applications">Applications</TabsTrigger>
                <TabsTrigger value="notes">Notes</TabsTrigger>
                <TabsTrigger value="tasks">Tasks</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
                <TabsTrigger value="documents">Documents</TabsTrigger>
              </TabsList>

              <TabsContent value="profile" className="mt-4">
                <div className="space-y-4">
                  {candidate.summary && (
                    <div>
                      <h3 className="text-sm font-medium mb-1">Summary</h3>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap">{candidate.summary}</p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Source</span>
                      <p>{candidate.source ?? "—"}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Added</span>
                      <p>{candidate.createdAt ? formatDistanceToNow(new Date(candidate.createdAt), { addSuffix: true }) : "—"}</p>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="applications" className="mt-4">
                {appsLoading ? (
                  <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
                ) : (
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left px-4 py-3 font-medium">Job</th>
                          <th className="text-left px-4 py-3 font-medium">Match</th>
                          <th className="text-left px-4 py-3 font-medium">Stage</th>
                          <th className="text-left px-4 py-3 font-medium">Applied</th>
                        </tr>
                      </thead>
                      <tbody>
                        {appsData?.applications.length === 0 && (
                          <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">No applications yet.</td></tr>
                        )}
                        {appsData?.applications.map((a) => (
                          <tr key={a.id} className="border-t hover:bg-muted/30">
                            <td className="px-4 py-3">
                              <Link href={`/jobs/${a.jobId}`} className="text-primary hover:underline">
                                {a.jobTitle ?? a.jobId}
                              </Link>
                            </td>
                            <td className="px-4 py-3">
                              <MatchBadge ms={scoresMap?.get(a.id)} />
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">{a.stage}</td>
                            <td className="px-4 py-3 text-muted-foreground text-xs">
                              {a.appliedAt ? formatDistanceToNow(new Date(a.appliedAt), { addSuffix: true }) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="activity" className="mt-4">
                <div className="p-6 text-center text-muted-foreground text-sm border rounded-lg">
                  Activity timeline coming in Phase 4.
                </div>
              </TabsContent>

              <TabsContent value="communications" className="mt-4">
                <CommunicationsTab emailV1Enabled={workspaceData?.emailV1Enabled ?? false} />
              </TabsContent>

              <TabsContent value="notes" className="mt-4">
                <NotesTab candidateId={id!} currentUserId={null} />
              </TabsContent>

              <TabsContent value="tasks" className="mt-4">
                <TasksTab candidateId={id!} />
              </TabsContent>

              <TabsContent value="documents" className="mt-4">
                <div className="p-6 text-center text-muted-foreground text-sm border rounded-lg">
                  Document management coming in a future phase.
                </div>
              </TabsContent>
            </Tabs>
          </>
        ) : (
          <p className="text-muted-foreground">Candidate not found.</p>
        )}
      </main>
    </div>
  );
}
