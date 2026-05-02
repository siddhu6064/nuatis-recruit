import { useState, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, Loader2, Clock, Building2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

type CandidateResult = {
  id: string;
  name: string;
  currentTitle: string | null;
  currentCompany: string | null;
  source: string | null;
  lastActivityAt: string | null;
  createdAt: string | null;
  score: number;
};

type SearchResponse = {
  candidates: CandidateResult[];
  nextCursor: string | null;
  latencyMs: number;
};

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function runSearch(
  q: string,
  stage: string,
  cursor?: string,
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q });
  if (stage) params.set("stage", stage);
  if (cursor) params.set("cursor", cursor);
  const r = await fetch(`${BASE}/api/candidates/search?${params}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<SearchResponse>;
}

export default function SearchPage() {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("");
  const [results, setResults] = useState<CandidateResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(
    async (q: string, st: string, cursor?: string) => {
      if (!q.trim()) {
        setResults([]);
        setHasSearched(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const data = await runSearch(q, st, cursor);
        setResults((prev) => (cursor ? [...prev, ...data.candidates] : data.candidates));
        setNextCursor(data.nextCursor);
        setLatency(data.latencyMs);
        setHasSearched(true);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const handleQueryChange = (v: string) => {
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(v, stage), 350);
  };

  const handleStageChange = (v: string) => {
    const s = v === "all" ? "" : v;
    setStage(s);
    doSearch(query, s);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSearch(query, stage);
  };

  const stages = [
    { value: "sourced",  label: "Sourced" },
    { value: "applied",  label: "Applied" },
    { value: "screen",   label: "Screen" },
    { value: "hm_round", label: "HM Round" },
    { value: "final",    label: "Final" },
    { value: "offer",    label: "Offer" },
    { value: "placed",   label: "Placed" },
    { value: "rejected", label: "Rejected" },
  ];

  return (
    <div className="max-w-3xl mx-auto py-8 px-4 space-y-6">
      <h1 className="text-2xl font-bold">Search Candidates</h1>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by name, title, company, summary…"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            autoFocus
          />
        </div>
        <Select value={stage || "all"} onValueChange={handleStageChange}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Stage" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All stages</SelectItem>
            {stages.map((s) => (
              <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
        </Button>
      </form>

      {latency !== null && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {results.length} result{results.length !== 1 ? "s" : ""} · {latency}ms
        </p>
      )}

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {hasSearched && results.length === 0 && !loading && (
        <p className="text-muted-foreground text-center py-16">No candidates found for "{query}"</p>
      )}

      <ul className="divide-y border rounded-lg overflow-hidden">
        {results.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-4 px-4 py-3 bg-card hover:bg-accent cursor-pointer transition-colors"
            onClick={() => navigate(`/candidates/${c.id}`)}
          >
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{c.name}</p>
              {(c.currentTitle || c.currentCompany) && (
                <p className="text-sm text-muted-foreground truncate flex items-center gap-1">
                  {c.currentCompany && <Building2 className="h-3 w-3 shrink-0" />}
                  {[c.currentTitle, c.currentCompany].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
            <div className="text-right shrink-0 space-y-1">
              <Badge variant="secondary" className="text-xs">
                {Math.round(c.score * 100)}%
              </Badge>
              {c.lastActivityAt && (
                <p className="text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(c.lastActivityAt), { addSuffix: true })}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>

      {nextCursor && (
        <div className="text-center">
          <Button
            variant="outline"
            onClick={() => doSearch(query, stage, nextCursor)}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
