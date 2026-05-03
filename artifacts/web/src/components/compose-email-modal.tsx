/**
 * Compose Email modal — Batch 6A.4.
 *
 * Opens from the Compose button in the candidate header or from the
 * Communications tab empty-state CTA. Uses the existing Radix Dialog
 * (no new library installed). Plaintext body textarea — matches 6A.3's
 * ReplyComposer choice exactly.
 *
 * 409 grant_missing → amber callout with /settings/email link (same
 * visual pattern as 6A.3 ReplyComposer).
 * Generic error → message shown in-modal, draft preserved for retry.
 */
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Send, AlertCircle, X } from "lucide-react";
import { Link } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Props = {
  open: boolean;
  onClose: () => void;
  candidateId: string;
  candidateEmails: string[];
  onSuccess: () => void;
};

export function ComposeEmailModal({
  open,
  onClose,
  candidateId,
  candidateEmails,
  onSuccess,
}: Props) {
  const [to, setTo] = useState(candidateEmails[0] ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [grantMissing, setGrantMissing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Reset form state each time the modal opens
  useEffect(() => {
    if (open) {
      setTo(candidateEmails[0] ?? "");
      setSubject("");
      setBody("");
      setSending(false);
      setGrantMissing(false);
      setErrorMsg(null);
    }
  }, [open, candidateEmails]);

  const canSend = Boolean(to.trim() && subject.trim() && body.trim() && !sending);

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setErrorMsg(null);
    setGrantMissing(false);

    try {
      const r = await fetch(`${BASE}/api/candidates/${candidateId}/email/compose`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: to.trim(),
          subject: subject.trim(),
          body: body.trim(),
        }),
      });

      if (r.status === 409) {
        setGrantMissing(true);
        return;
      }

      if (!r.ok) {
        const data = (await r.json()) as Record<string, unknown>;
        setErrorMsg((data.error as string | undefined) ?? "Send failed — please try again");
        return;
      }

      onSuccess();
      onClose();
    } catch {
      setErrorMsg("Network error — please try again");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !sending) onClose(); }}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle>Compose Email</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* To */}
          <div className="space-y-1.5">
            <Label htmlFor="compose-to">To</Label>
            {candidateEmails.length > 1 ? (
              <select
                id="compose-to"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {candidateEmails.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id="compose-to"
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="recipient@example.com"
              />
            )}
          </div>

          {/* Subject */}
          <div className="space-y-1.5">
            <Label htmlFor="compose-subject">Subject</Label>
            <Input
              id="compose-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              onKeyDown={(e) => {
                if (e.key === "Tab") {
                  e.preventDefault();
                  document.getElementById("compose-body")?.focus();
                }
              }}
            />
          </div>

          {/* Body — plaintext textarea, same as ReplyComposer in 6A.3 */}
          <div className="space-y-1.5">
            <Label htmlFor="compose-body">Message</Label>
            <textarea
              id="compose-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  void handleSend();
                }
              }}
              placeholder="Write your message… (⌘↵ to send)"
              rows={7}
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Grant missing callout — same amber pattern as 6A.3 ReplyComposer */}
          {grantMissing && (
            <div className="border rounded-lg p-4 bg-amber-50 dark:bg-amber-950/30 text-sm flex items-start gap-3">
              <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-medium text-amber-800 dark:text-amber-200">
                  No connected inbox
                </p>
                <p className="text-amber-700 dark:text-amber-300 mt-0.5">
                  <Link href="/settings/email" className="underline">
                    Connect your inbox
                  </Link>{" "}
                  to send emails.
                </p>
              </div>
              <button onClick={() => setGrantMissing(false)}>
                <X className="h-4 w-4 text-amber-500 hover:opacity-70" />
              </button>
            </div>
          )}

          {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button disabled={!canSend} onClick={() => void handleSend()}>
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Send className="h-4 w-4 mr-1.5" />
                Send
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
