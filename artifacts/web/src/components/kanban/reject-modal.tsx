import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

type RejectionReason = {
  id: string;
  label: string;
  sortOrder: number | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  onConfirm: (reasonId: string | null, sendEmail: boolean) => void;
  isPending: boolean;
};

export function RejectModal({ open, onOpenChange, count, onConfirm, isPending }: Props) {
  const [selectedReasonId, setSelectedReasonId] = useState<string | null>(null);
  const [sendEmail, setSendEmail] = useState(false);

  const { data } = useQuery<{ rejectionReasons: RejectionReason[] }>({
    queryKey: ["/api/rejection-reasons"],
    queryFn: async () => {
      const res = await fetch("/api/rejection-reasons", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load rejection reasons");
      return res.json();
    },
    enabled: open,
  });

  const reasons = data?.rejectionReasons ?? [];

  const handleConfirm = () => {
    onConfirm(selectedReasonId, sendEmail);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            Reject {count} candidate{count !== 1 ? "s" : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">Select a rejection reason (optional):</p>

          <div className="space-y-1 max-h-48 overflow-y-auto">
            {reasons.map((r) => (
              <button
                key={r.id}
                className={`w-full text-left text-sm px-3 py-2 rounded-md transition-colors ${
                  selectedReasonId === r.id
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted"
                }`}
                onClick={() =>
                  setSelectedReasonId(selectedReasonId === r.id ? null : r.id)
                }
              >
                {r.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Checkbox
              id="send-email"
              checked={sendEmail}
              onCheckedChange={(v) => setSendEmail(Boolean(v))}
            />
            <Label htmlFor="send-email" className="text-sm cursor-pointer">
              Send rejection email{" "}
              <span className="text-muted-foreground text-xs">(template stub — Phase 4)</span>
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={isPending}>
            {isPending ? "Rejecting…" : `Reject ${count}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
