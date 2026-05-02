import { useState, useCallback, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useToast } from "@/hooks/use-toast";
import { KanbanColumn } from "./column";
import { KanbanCard, type KanbanCardData } from "./card";
import { RejectModal } from "./reject-modal";
import { Button } from "@/components/ui/button";
import { X, ArrowRight, Ban } from "lucide-react";
import type { StageDefinition } from "./types";

type Props = {
  stages: StageDefinition[];
  applications: KanbanCardData[];
  onMove: (applicationId: string, stage: string, positionInStage: number) => Promise<void>;
  onBulkMove: (applicationIds: string[], stage: string) => Promise<void>;
  onBulkReject: (applicationIds: string[], reasonId: string | null, sendEmail: boolean) => Promise<void>;
  isBulkMovePending: boolean;
  isBulkRejectPending: boolean;
};

export function KanbanBoard({
  stages,
  applications,
  onMove,
  onBulkMove,
  onBulkReject,
  isBulkMovePending,
  isBulkRejectPending,
}: Props) {
  const { toast } = useToast();
  const [activeCard, setActiveCard] = useState<KanbanCardData | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rejectOpen, setRejectOpen] = useState(false);
  const [bulkMoveTarget, setBulkMoveTarget] = useState<string | null>(null);
  const lastSelectedRef = useRef<string | null>(null);

  // Local optimistic state for applications
  const [localApps, setLocalApps] = useState<KanbanCardData[]>(applications);

  // Sync when prop changes (after query invalidation)
  const prevApps = useRef(applications);
  if (prevApps.current !== applications) {
    prevApps.current = applications;
    setLocalApps(applications);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Group by stage
  const byStage = useCallback(
    (apps: KanbanCardData[]) => {
      const map = new Map<string, KanbanCardData[]>();
      for (const s of stages) map.set(s.key, []);
      for (const app of apps) {
        const col = map.get(app.stage) ?? [];
        col.push(app);
        map.set(app.stage, col);
      }
      // Sort by positionInStage
      for (const [k, v] of map) map.set(k, [...v].sort((a, b) => a.positionInStage - b.positionInStage));
      return map;
    },
    [stages],
  );

  const columnMap = byStage(localApps);

  // ── Selection ────────────────────────────────────────────────────────────

  const handleSelect = useCallback(
    (id: string, mode: "single" | "range" | "toggle") => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (mode === "toggle") {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        } else if (mode === "single") {
          if (next.has(id) && next.size === 1) {
            next.clear(); // deselect if only one selected
          } else {
            next.clear();
            next.add(id);
          }
        } else if (mode === "range" && lastSelectedRef.current) {
          const allIds = localApps.map((a) => a.id);
          const start = allIds.indexOf(lastSelectedRef.current);
          const end = allIds.indexOf(id);
          const [lo, hi] = start < end ? [start, end] : [end, start];
          for (let i = lo; i <= hi; i++) next.add(allIds[i]);
        }
        lastSelectedRef.current = id;
        return next;
      });
    },
    [localApps],
  );

  // ── Drag & Drop ──────────────────────────────────────────────────────────

  const onDragStart = useCallback((event: DragStartEvent) => {
    const card = localApps.find((a) => a.id === event.active.id);
    if (card) setActiveCard(card);
  }, [localApps]);

  const onDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over) return;

      const activeApp = localApps.find((a) => a.id === active.id);
      if (!activeApp) return;

      // Determine target stage
      const overData = over.data.current as { type: string; stageKey?: string; card?: KanbanCardData };
      const targetStage = overData.type === "column"
        ? overData.stageKey!
        : overData.type === "card"
        ? (localApps.find((a) => a.id === over.id)?.stage ?? activeApp.stage)
        : activeApp.stage;

      if (targetStage !== activeApp.stage) {
        // Optimistically move to target stage
        setLocalApps((prev) =>
          prev.map((a) => (a.id === activeApp.id ? { ...a, stage: targetStage } : a)),
        );
      } else if (overData.type === "card" && over.id !== active.id) {
        // Reorder within same stage
        const stageCards = localApps
          .filter((a) => a.stage === activeApp.stage)
          .sort((a, b) => a.positionInStage - b.positionInStage);
        const oldIndex = stageCards.findIndex((c) => c.id === active.id);
        const newIndex = stageCards.findIndex((c) => c.id === over.id);
        if (oldIndex !== -1 && newIndex !== -1) {
          const reordered = arrayMove(stageCards, oldIndex, newIndex).map((c, i) => ({
            ...c,
            positionInStage: (i + 1) * 1000,
          }));
          setLocalApps((prev) => {
            const others = prev.filter((a) => a.stage !== activeApp.stage);
            return [...others, ...reordered];
          });
        }
      }
    },
    [localApps],
  );

  const onDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveCard(null);

      if (!over) {
        // Dropped outside — revert
        setLocalApps(applications);
        return;
      }

      const movedApp = localApps.find((a) => a.id === active.id);
      if (!movedApp) return;

      // Calculate new position from current local state
      const stageCards = localApps
        .filter((a) => a.stage === movedApp.stage)
        .sort((a, b) => a.positionInStage - b.positionInStage);
      const idx = stageCards.findIndex((c) => c.id === movedApp.id);
      const newPos = stageCards[idx]?.positionInStage ?? 1000;

      try {
        await onMove(movedApp.id, movedApp.stage, newPos);
      } catch {
        // Rollback optimistic update
        setLocalApps(applications);
        toast({
          title: "Couldn't save move — try again",
          variant: "destructive",
        });
      }
    },
    [localApps, applications, onMove, toast],
  );

  // ── Bulk actions ─────────────────────────────────────────────────────────

  const handleBulkMove = async (targetStage: string) => {
    const ids = [...selectedIds];
    // Optimistic
    setLocalApps((prev) =>
      prev.map((a) => (ids.includes(a.id) ? { ...a, stage: targetStage } : a)),
    );
    setSelectedIds(new Set());
    setBulkMoveTarget(null);
    try {
      await onBulkMove(ids, targetStage);
    } catch {
      setLocalApps(applications);
      toast({ title: "Bulk move failed — try again", variant: "destructive" });
    }
  };

  const handleBulkReject = async (reasonId: string | null, sendEmail: boolean) => {
    const ids = [...selectedIds];
    setRejectOpen(false);
    // Optimistic
    setLocalApps((prev) =>
      prev.map((a) => (ids.includes(a.id) ? { ...a, stage: "rejected" } : a)),
    );
    setSelectedIds(new Set());
    try {
      await onBulkReject(ids, reasonId, sendEmail);
    } catch {
      setLocalApps(applications);
      toast({ title: "Bulk reject failed — try again", variant: "destructive" });
    }
  };

  const selectedCount = selectedIds.size;
  const bulkStages = stages.filter((s) => s.key !== "rejected");

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        <div className="overflow-x-auto pb-4">
          <div className="flex gap-3 min-w-max">
            {stages.map((s) => (
              <KanbanColumn
                key={s.key}
                stageKey={s.key}
                stageLabel={s.label}
                cards={columnMap.get(s.key) ?? []}
                selectedIds={selectedIds}
                onSelect={handleSelect}
              />
            ))}
          </div>
        </div>

        <DragOverlay dropAnimation={null}>
          {activeCard ? (
            <KanbanCard
              card={activeCard}
              selected={selectedIds.has(activeCard.id)}
              onSelect={() => {/* no-op */}}
              isDragOverlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Bulk action bar */}
      {selectedCount > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-3 bg-popover border rounded-xl shadow-lg">
          <span className="text-sm font-medium mr-1">
            {selectedCount} selected
          </span>

          {/* Move to stage picker */}
          <div className="relative group">
            <Button size="sm" variant="outline" className="gap-1">
              <ArrowRight className="w-3.5 h-3.5" />
              Move to…
            </Button>
            <div className="absolute bottom-full mb-1 left-0 hidden group-hover:flex flex-col bg-popover border rounded-lg shadow-lg min-w-[140px] py-1 z-50">
              {bulkStages.map((s) => (
                <button
                  key={s.key}
                  className="text-sm px-3 py-1.5 hover:bg-muted text-left"
                  onClick={() => handleBulkMove(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <Button
            size="sm"
            variant="destructive"
            className="gap-1"
            onClick={() => setRejectOpen(true)}
            disabled={isBulkRejectPending}
          >
            <Ban className="w-3.5 h-3.5" />
            Reject…
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="gap-1"
            onClick={() => setSelectedIds(new Set())}
          >
            <X className="w-3.5 h-3.5" />
            Clear
          </Button>
        </div>
      )}

      <RejectModal
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        count={selectedCount}
        onConfirm={handleBulkReject}
        isPending={isBulkRejectPending}
      />
    </>
  );
}
