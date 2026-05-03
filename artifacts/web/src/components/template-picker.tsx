/**
 * TemplatePicker — renders a grouped <select> of active workspace email templates.
 *
 * On selection, calls POST /api/email-templates/:id/render with candidateId
 * (and optional jobId), then delivers the hydrated { subject, body, missingTokens }
 * to the parent via onApply.
 *
 * The component renders nothing until templates are loaded AND at least one exists.
 * It remounts cleanly via `key` prop whenever the owning modal reopens.
 */
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Label } from "@/components/ui/label";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const CATEGORY_LABELS: Record<string, string> = {
  outreach:   "Outreach",
  screening:  "Screening",
  interview:  "Interview",
  offer:      "Offer",
  rejection:  "Rejection",
  follow_up:  "Follow-up",
  other:      "Other",
};

type Template = {
  id: string;
  name: string;
  category: string;
  updatedAt: string | null;
};

type Props = {
  candidateId: string;
  jobId?: string;
  onApply: (subject: string, body: string, missingTokens: string[]) => void;
  disabled?: boolean;
};

export function TemplatePicker({ candidateId, jobId, onApply, disabled }: Props) {
  const [applying, setApplying] = useState(false);

  const { data } = useQuery<{ templates: Template[] }>({
    queryKey: ["/api/email-templates"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/email-templates`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load templates");
      return r.json() as Promise<{ templates: Template[] }>;
    },
    staleTime: 60_000,
  });

  // Group by category, sorted by updatedAt desc within each group.
  const grouped = useMemo(() => {
    const templates = data?.templates ?? [];
    const map = new Map<string, Template[]>();
    for (const t of templates) {
      const arr = map.get(t.category) ?? [];
      arr.push(t);
      map.set(t.category, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    }
    return map;
  }, [data]);

  const hasTemplates = grouped.size > 0;

  // Ordered categories — insertion order reflects server sort, stabilise with known list.
  const categoryOrder = [
    "outreach", "screening", "interview", "offer", "rejection", "follow_up", "other",
  ];
  const orderedCategories = [
    ...categoryOrder.filter((c) => grouped.has(c)),
    ...[...grouped.keys()].filter((c) => !categoryOrder.includes(c)),
  ];

  if (!hasTemplates) return null;

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const templateId = e.target.value;
    if (!templateId) return;
    // Reset immediately so user can re-select same template.
    e.target.value = "";
    setApplying(true);
    try {
      const r = await fetch(`${BASE}/api/email-templates/${templateId}/render`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId, jobId }),
      });
      if (!r.ok) return;
      const payload = (await r.json()) as {
        subject: string;
        body: string;
        missingTokens: string[];
      };
      onApply(payload.subject, payload.body, payload.missingTokens);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <Label>Use template</Label>
      <select
        defaultValue=""
        onChange={(e) => void handleChange(e)}
        disabled={disabled || applying}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <option value="" disabled>
          — select a template —
        </option>
        {orderedCategories.map((category) => (
          <optgroup
            key={category}
            label={CATEGORY_LABELS[category] ?? category}
          >
            {(grouped.get(category) ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {applying && (
        <p className="text-xs text-muted-foreground">Applying template…</p>
      )}
    </div>
  );
}
