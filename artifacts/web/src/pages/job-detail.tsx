import { useAuth } from "@workspace/replit-auth-web";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { Nav } from "@/components/nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, MapPin, DollarSign, LayoutGrid, List } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { KanbanBoard } from "@/components/kanban/board";
import { LiveIndicator } from "@/components/kanban/live-indicator";
import type { KanbanCardData } from "@/components/kanban/card";
import type { StageDefinition } from "@/components/kanban/types";

type Job = {
  id: string;
  title: string;
  status: string;
  description: string | null;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  employmentType: string | null;
  slug: string;
  clientId: string;
  stagesJson: StageDefinition[] | null;
  createdAt: string | null;
};

type Application = {
  id: string;
  candidateId: string;
  candidateName: string | null;
  candidateCurrentTitle: string | null;
  stage: string;
  positionInStage: number;
  source: string | null;
  appliedAt: string | null;
  lastActivityAt: string | null;
  lastStageChangedAt: string | null;
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
  createdAt: string | null;
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  open: "bg-emerald-50 text-emerald-700 border-emerald-200",
  on_hold: "bg-yellow-50 text-yellow-700 border-yellow-200",
  closed: "bg-red-50 text-red-600 border-red-200",
  filled: "bg-blue-50 text-blue-700 border-blue-200",
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
                  {(["skills", "experience", "seniority", "location"] as const).map((k) => (
                    <div key={k} className="bg-muted/40 rounded p-2">
                      <div className="text-xs text-muted-foreground capitalize">{k}</div>
                      <div className="font-semibold">{bd[k]}</div>
                    </div>
                  ))}
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

const DEFAULT_STAGES: StageDefinition[] = [
  { key: "sourced",   label: "Sourced",   order: 0 },
  { key: "applied",   label: "Applied",   order: 1 },
  { key: "screen",    label: "Screen",    order: 2 },
  { key: "hm_round",  label: "HM Round",  order: 3 },
  { key: "final",     label: "Final",     order: 4 },
  { key: "offer",     label: "Offer",     order: 5 },
  { key: "placed",    label: "Placed",    order: 6 },
  { key: "rejected",  label: "Rejected",  order: 7 },
];

type ViewMode = "kanban" | "list";

export default function JobDetail() {
  const { isLoading, isAuthenticated, login } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const pollCountRef = useRef(0);
  const [viewMode, setViewMode] = useState<ViewMode>("kanban");

  useEffect(() => {
    if (!isLoading && !isAuthenticated) login();
  }, [isLoading, isAuthenticated, login]);

  const { data: job, isLoading: jobLoading } = useQuery<Job>({
    queryKey: ["/api/jobs", id],
    queryFn: async () => {
      const res = await fetch(`/api/jobs/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch job");
      return res.json();
    },
    enabled: !!id,
  });

  const { data: appsData, isLoading: appsLoading } = useQuery<{ applications: Application[] }>({
    queryKey: ["/api/applications", id],
    queryFn: async () => {
      const res = await fetch(`/api/applications?job_id=${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch applications");
      return res.json();
    },
    enabled: !!id,
  });

  // Poll match scores every 3s until all apps have scores or 10 polls reached
  const { data: scoresData } = useQuery<{ matchScores: MatchScore[] }>({
    queryKey: ["/api/match-scores/job", id],
    queryFn: async () => {
      pollCountRef.current += 1;
      const res = await fetch(`/api/match-scores?job_id=${id}`, { credentials: "include" });
      if (!res.ok) return { matchScores: [] };
      return res.json();
    },
    enabled: !!id,
    refetchInterval: (query) => {
      if (pollCountRef.current >= 10) return false;
      const scores = (query.state.data as { matchScores: MatchScore[] } | undefined)?.matchScores ?? [];
      const apps = appsData?.applications ?? [];
      if (apps.length > 0 && apps.every((a) => scores.some((s) => s.applicationId === a.id))) return false;
      return 3000;
    },
  });

  const scoreMap = new Map((scoresData?.matchScores ?? []).map((s) => [s.applicationId, s]));

  // ── Stage move mutation ────────────────────────────────────────────────────
  const moveMutation = useMutation({
    mutationFn: async ({ appId, stage, positionInStage }: { appId: string; stage: string; positionInStage: number }) => {
      const res = await fetch(`/api/applications/${appId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ stage, positionInStage }),
      });
      if (!res.ok) throw new Error("Move failed");
      return res.json();
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/applications", id] }),
    onError: (e) => toast({ title: "Move failed", description: (e as Error).message, variant: "destructive" }),
  });

  const bulkMoveMutation = useMutation({
    mutationFn: async ({ applicationIds, stage }: { applicationIds: string[]; stage: string }) => {
      const res = await fetch("/api/applications/bulk-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ applicationIds, stage }),
      });
      if (!res.ok) throw new Error("Bulk move failed");
      return res.json();
    },
    onSuccess: (data: { moved: number; stage: string }) => {
      void qc.invalidateQueries({ queryKey: ["/api/applications", id] });
      toast({ title: `${data.moved} candidate${data.moved !== 1 ? "s" : ""} moved to ${data.stage}` });
    },
    onError: (e) => toast({ title: "Bulk move failed", description: (e as Error).message, variant: "destructive" }),
  });

  const bulkRejectMutation = useMutation({
    mutationFn: async ({
      applicationIds,
      rejectionReasonId,
      sendEmail,
    }: {
      applicationIds: string[];
      rejectionReasonId: string | null;
      sendEmail: boolean;
    }) => {
      const res = await fetch("/api/applications/bulk-reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ applicationIds, rejectionReasonId, sendTemplateEmail: sendEmail }),
      });
      if (!res.ok) throw new Error("Bulk reject failed");
      return res.json();
    },
    onSuccess: (data: { rejected: number }) => {
      void qc.invalidateQueries({ queryKey: ["/api/applications", id] });
      toast({ title: `${data.rejected} candidate${data.rejected !== 1 ? "s" : ""} rejected` });
    },
    onError: (e) => toast({ title: "Bulk reject failed", description: (e as Error).message, variant: "destructive" }),
  });

  // ── Publish mutation ───────────────────────────────────────────────────────
  const publishJob = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/jobs/${id}/publish`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error("Failed to publish job");
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/jobs", id] });
      void qc.invalidateQueries({ queryKey: ["/api/jobs"] });
      toast({ title: "Job published — now accepting applications" });
    },
    onError: (e) => toast({ title: "Error", description: (e as Error).message, variant: "destructive" }),
  });

  // ── SSE → invalidate applications query ───────────────────────────────────
  const handleSSEEvent = useCallback(
    (_payload: Record<string, unknown>) => {
      void qc.invalidateQueries({ queryKey: ["/api/applications", id] });
    },
    [qc, id],
  );

  // ── Kanban helpers ─────────────────────────────────────────────────────────
  const stages = (job?.stagesJson && job.stagesJson.length > 0 ? job.stagesJson : DEFAULT_STAGES)
    .slice()
    .sort((a, b) => a.order - b.order);

  const kanbanCards: KanbanCardData[] = (appsData?.applications ?? []).map((a) => ({
    id: a.id,
    candidateId: a.candidateId,
    candidateName: a.candidateName,
    candidateCurrentTitle: a.candidateCurrentTitle,
    stage: a.stage,
    positionInStage: a.positionInStage,
    source: a.source,
    appliedAt: a.appliedAt,
    lastStageChangedAt: a.lastStageChangedAt,
    matchScore: scoreMap.get(a.id)?.score ?? null,
  }));

  const handleMove = useCallback(
    (appId: string, stage: string, positionInStage: number) =>
      moveMutation.mutateAsync({ appId, stage, positionInStage }),
    [moveMutation],
  );

  const handleBulkMove = useCallback(
    (applicationIds: string[], stage: string) =>
      bulkMoveMutation.mutateAsync({ applicationIds, stage }),
    [bulkMoveMutation],
  );

  const handleBulkReject = useCallback(
    (applicationIds: string[], rejectionReasonId: string | null, sendEmail: boolean) =>
      bulkRejectMutation.mutateAsync({ applicationIds, rejectionReasonId, sendEmail }),
    [bulkRejectMutation],
  );

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="max-w-full px-6 py-8">
        <div className="max-w-5xl mx-auto">
          <Link href="/jobs" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6">
            <ArrowLeft className="w-4 h-4" /> Jobs
          </Link>

          {jobLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-5 w-40" />
            </div>
          ) : job ? (
            <>
              {/* Job header */}
              <div className="flex items-start justify-between mb-6">
                <div>
                  <div className="flex items-center gap-3 mb-1">
                    <h1 className="text-2xl font-semibold">{job.title}</h1>
                    <Badge variant="outline" className={`text-xs ${STATUS_COLORS[job.status] ?? ""}`}>
                      {job.status.replace("_", " ")}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                    {job.location && (
                      <span className="flex items-center gap-1">
                        <MapPin className="w-4 h-4" />{job.location}
                      </span>
                    )}
                    {(job.salaryMin || job.salaryMax) && (
                      <span className="flex items-center gap-1">
                        <DollarSign className="w-4 h-4" />
                        {job.salaryMin && job.salaryMax
                          ? `$${job.salaryMin.toLocaleString()} – $${job.salaryMax.toLocaleString()}`
                          : job.salaryMin
                          ? `From $${job.salaryMin.toLocaleString()}`
                          : `Up to $${job.salaryMax?.toLocaleString()}`}
                      </span>
                    )}
                    {job.employmentType && <span>{job.employmentType.replace("_", " ")}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {job.status === "draft" && (
                    <Button size="sm" onClick={() => publishJob.mutate()} disabled={publishJob.isPending}>
                      {publishJob.isPending ? "Publishing…" : "Publish"}
                    </Button>
                  )}
                </div>
              </div>

              {job.description && (
                <div className="mb-6 p-4 bg-muted/30 rounded-lg text-sm whitespace-pre-wrap">
                  {job.description}
                </div>
              )}

              {job.status === "open" && (
                <div className="mb-6 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
                  Public apply URL:{" "}
                  <code className="font-mono">/api/public/jobs/{job.slug}</code>
                </div>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">Job not found.</p>
          )}
        </div>

        {job && (
          <>
            {/* Applicants header: view toggle + live indicator */}
            <div className="max-w-5xl mx-auto flex items-center justify-between mb-4">
              <h2 className="text-lg font-medium">Applicants</h2>
              <div className="flex items-center gap-3">
                {id && <LiveIndicator jobId={id} onEvent={handleSSEEvent} />}
                <div className="flex border rounded-md overflow-hidden">
                  <button
                    className={`px-2.5 py-1.5 text-xs flex items-center gap-1 transition-colors ${viewMode === "kanban" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                    onClick={() => setViewMode("kanban")}
                  >
                    <LayoutGrid className="w-3.5 h-3.5" /> Kanban
                  </button>
                  <button
                    className={`px-2.5 py-1.5 text-xs flex items-center gap-1 border-l transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                    onClick={() => setViewMode("list")}
                  >
                    <List className="w-3.5 h-3.5" /> List
                  </button>
                </div>
              </div>
            </div>

            {appsLoading ? (
              <div className="max-w-5xl mx-auto space-y-2">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : viewMode === "kanban" ? (
              <KanbanBoard
                stages={stages}
                applications={kanbanCards}
                onMove={handleMove}
                onBulkMove={handleBulkMove}
                onBulkReject={handleBulkReject}
                isBulkMovePending={bulkMoveMutation.isPending}
                isBulkRejectPending={bulkRejectMutation.isPending}
              />
            ) : (
              /* List view (table — preserved from Batch 3) */
              <div className="max-w-5xl mx-auto border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium">Candidate</th>
                      <th className="text-left px-4 py-3 font-medium">Match</th>
                      <th className="text-left px-4 py-3 font-medium">Stage</th>
                      <th className="text-left px-4 py-3 font-medium">Source</th>
                      <th className="text-left px-4 py-3 font-medium">Applied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {appsData?.applications.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                          No applicants yet.
                        </td>
                      </tr>
                    )}
                    {appsData?.applications.map((a) => (
                      <tr key={a.id} className="border-t hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <Link href={`/candidates/${a.candidateId}`} className="text-primary hover:underline">
                            {a.candidateName ?? a.candidateId}
                          </Link>
                          {a.candidateCurrentTitle && (
                            <p className="text-xs text-muted-foreground">{a.candidateCurrentTitle}</p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <MatchBadge ms={scoreMap.get(a.id)} />
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{a.stage}</td>
                        <td className="px-4 py-3 text-muted-foreground">{a.source ?? "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">
                          {a.appliedAt
                            ? formatDistanceToNow(new Date(a.appliedAt), { addSuffix: true })
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
