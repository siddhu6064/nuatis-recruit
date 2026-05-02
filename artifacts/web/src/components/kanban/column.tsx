import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { KanbanCard, type KanbanCardData } from "./card";

type Props = {
  stageKey: string;
  stageLabel: string;
  cards: KanbanCardData[];
  selectedIds: Set<string>;
  onSelect: (id: string, mode: "single" | "range" | "toggle") => void;
  isOver?: boolean;
};

export function KanbanColumn({ stageKey, stageLabel, cards, selectedIds, onSelect }: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: stageKey,
    data: { type: "column", stageKey },
  });

  const cardIds = cards.map((c) => c.id);

  return (
    <div className="flex flex-col min-w-[220px] max-w-[240px] flex-shrink-0">
      {/* Column header */}
      <div className="flex items-center justify-between px-2 pb-2 mb-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground truncate">
          {stageLabel}
        </span>
        <span className="text-xs text-muted-foreground bg-muted rounded px-1.5 py-0.5 min-w-[20px] text-center">
          {cards.length}
        </span>
      </div>

      {/* Drop zone */}
      <div
        ref={setNodeRef}
        className={cn(
          "flex flex-col gap-2 min-h-[120px] rounded-lg p-2 transition-colors",
          isOver
            ? "bg-primary/5 border-2 border-dashed border-primary/40"
            : "bg-muted/30 border-2 border-transparent",
        )}
      >
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <KanbanCard
              key={card.id}
              card={card}
              selected={selectedIds.has(card.id)}
              onSelect={onSelect}
            />
          ))}
        </SortableContext>

        {cards.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">Empty</p>
        )}
      </div>
    </div>
  );
}
