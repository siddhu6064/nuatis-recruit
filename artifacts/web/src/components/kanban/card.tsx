import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "wouter";
import { formatDistanceToNow, differenceInDays } from "date-fns";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

export type KanbanCardData = {
  id: string;
  candidateId: string;
  candidateName: string | null;
  candidateCurrentTitle: string | null;
  stage: string;
  positionInStage: number;
  source: string | null;
  appliedAt: string | null;
  lastStageChangedAt: string | null;
  matchScore: number | null;
};

type Props = {
  card: KanbanCardData;
  selected: boolean;
  onSelect: (id: string, mode: "single" | "range" | "toggle") => void;
  isDragOverlay?: boolean;
};

function scoreBadgeClass(score: number): string {
  if (score >= 75) return "bg-emerald-100 text-emerald-800 border-emerald-300";
  if (score >= 50) return "bg-yellow-100 text-yellow-800 border-yellow-300";
  return "bg-red-100 text-red-800 border-red-300";
}

function daysInStage(card: KanbanCardData): number {
  const from = card.lastStageChangedAt ?? card.appliedAt;
  if (!from) return 0;
  return differenceInDays(new Date(), new Date(from));
}

export function KanbanCard({ card, selected, onSelect, isDragOverlay = false }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: "card", card },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const days = daysInStage(card);

  const handleClick = (e: React.MouseEvent) => {
    if (e.shiftKey) {
      onSelect(card.id, "range");
    } else if (e.metaKey || e.ctrlKey) {
      onSelect(card.id, "toggle");
    } else {
      onSelect(card.id, "single");
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group relative bg-card border rounded-lg p-3 cursor-pointer select-none",
        "hover:border-primary/40 hover:shadow-sm transition-all",
        selected && "border-primary bg-primary/5 ring-1 ring-primary/30",
        isDragging && "opacity-40",
        isDragOverlay && "shadow-xl rotate-1 scale-105",
      )}
      onClick={handleClick}
    >
      {/* drag handle */}
      <div
        {...attributes}
        {...listeners}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-40 hover:!opacity-100 cursor-grab active:cursor-grabbing p-0.5"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
      </div>

      {/* name */}
      <Link
        href={`/candidates/${card.candidateId}`}
        className="text-sm font-medium text-foreground hover:text-primary hover:underline block truncate pr-5"
        onClick={(e) => e.stopPropagation()}
      >
        {card.candidateName ?? "Unknown"}
      </Link>

      {/* current title */}
      {card.candidateCurrentTitle && (
        <p className="text-xs text-muted-foreground truncate mt-0.5">{card.candidateCurrentTitle}</p>
      )}

      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        {/* match score badge */}
        {card.matchScore !== null ? (
          <span
            className={cn(
              "inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold border",
              scoreBadgeClass(card.matchScore),
            )}
          >
            {card.matchScore}
          </span>
        ) : (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs border bg-muted text-muted-foreground">
            —
          </span>
        )}

        {/* source */}
        {card.source && (
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded truncate max-w-[80px]">
            {card.source}
          </span>
        )}

        {/* days in stage */}
        <span className="text-xs text-muted-foreground ml-auto">
          {days === 0 ? "today" : `${days}d`}
        </span>
      </div>
    </div>
  );
}

/** Lightweight placeholder shown where dragged card was */
export function CardGhost() {
  return (
    <div className="border-2 border-dashed border-primary/30 rounded-lg h-[72px] bg-primary/5" />
  );
}
