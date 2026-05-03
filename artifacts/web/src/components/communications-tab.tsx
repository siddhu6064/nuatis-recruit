import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Mail, ChevronRight, Loader2, Inbox, Send, Clock,
  AlertCircle, CornerDownLeft, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type EmailThread = {
  id: string;
  subject: string;
  lastMessageAt: string | null;
  messageCount: number;
  nylasThreadId: string | null;
  createdAt: string | null;
};

type EmailMessage = {
  id: string;
  direction: "inbound" | "outbound";
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  sentAt: string | null;
  status: string;
  nylasMessageId: string | null;
  inReplyTo?: string | null;
};

type Props = {
  candidateId: string;
  emailV1Enabled: boolean;
};

// ── Message bubble ─────────────────────────────────────────────────────────

function StatusIndicator({
  status,
  onRetry,
  bodyText,
}: {
  status: string;
  onRetry: (body: string) => void;
  bodyText: string;
}) {
  if (status === "queued") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" /> Sending…
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex items-center gap-2">
        <span className="flex items-center gap-1 text-xs text-destructive">
          <AlertCircle className="h-3 w-3" /> Failed
        </span>
        <button
          className="text-xs underline text-destructive hover:opacity-70"
          onClick={() => onRetry(bodyText)}
        >
          Retry
        </button>
      </span>
    );
  }
  return null;
}

function MessageBubble({
  message,
  onRetry,
}: {
  message: EmailMessage;
  onRetry: (body: string) => void;
}) {
  const isInbound = message.direction === "inbound";
  const isFailed = !isInbound && message.status === "failed";
  const isQueued = !isInbound && message.status === "queued";

  return (
    <div className={`flex ${isInbound ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 text-sm space-y-1 ${
          isInbound
            ? "bg-muted border"
            : isFailed
            ? "bg-destructive/10 border border-destructive/30"
            : isQueued
            ? "bg-muted border border-dashed opacity-70"
            : "bg-primary text-primary-foreground"
        }`}
      >
        <p
          className={`text-xs font-medium ${
            isInbound || isFailed || isQueued ? "opacity-60" : "opacity-70"
          }`}
        >
          {isInbound
            ? message.fromAddress
            : `You → ${message.toAddresses[0] ?? ""}`}
        </p>
        <p className="leading-relaxed whitespace-pre-wrap">
          {message.bodyText || "(no preview)"}
        </p>
        <div className="flex items-center justify-end gap-2 pt-0.5">
          {!isInbound && (
            <StatusIndicator
              status={message.status}
              onRetry={onRetry}
              bodyText={message.bodyText}
            />
          )}
          <p
            className={`text-xs ${
              isInbound || isFailed || isQueued
                ? "opacity-50"
                : "opacity-60"
            }`}
          >
            {message.sentAt
              ? formatDistanceToNow(new Date(message.sentAt), { addSuffix: true })
              : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Reply composer ─────────────────────────────────────────────────────────

function ReplyComposer({
  threadId,
  initialBody,
  onClose,
  onSent,
}: {
  threadId: string;
  initialBody?: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [body, setBody] = useState(initialBody ?? "");
  const [sending, setSending] = useState(false);
  const [grantMissing, setGrantMissing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  async function handleSend() {
    const trimmed = body.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setErrorMsg(null);
    setGrantMissing(false);

    try {
      const r = await fetch(`${BASE}/api/email/threads/${threadId}/reply`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed }),
      });

      if (r.status === 409) {
        setGrantMissing(true);
        return;
      }

      if (!r.ok) {
        const data = await r.json() as Record<string, unknown>;
        setErrorMsg((data.error as string | undefined) ?? "Send failed");
        return;
      }

      // Invalidate both thread list and message list on success
      void queryClient.invalidateQueries({ queryKey: ["email-thread-messages", threadId] });
      void queryClient.invalidateQueries({ queryKey: ["email-threads"] });
      onSent();
    } catch (err) {
      setErrorMsg("Network error — please try again");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      void handleSend();
    }
  }

  if (grantMissing) {
    return (
      <div className="border rounded-lg p-4 bg-amber-50 dark:bg-amber-950/30 text-sm flex items-start gap-3">
        <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="font-medium text-amber-800 dark:text-amber-200">No connected inbox</p>
          <p className="text-amber-700 dark:text-amber-300 mt-0.5">
            <Link href="/settings/email" className="underline">
              Connect your inbox
            </Link>{" "}
            to send replies.
          </p>
        </div>
        <button onClick={() => setGrantMissing(false)}>
          <X className="h-4 w-4 text-amber-500 hover:opacity-70" />
        </button>
      </div>
    );
  }

  return (
    <div className="border rounded-lg p-3 space-y-2 bg-background">
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Write a reply… (⌘↵ to send)"
        rows={4}
        className="w-full resize-none text-sm rounded border-0 focus:outline-none bg-transparent placeholder:text-muted-foreground"
      />
      {errorMsg && (
        <p className="text-xs text-destructive">{errorMsg}</p>
      )}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Plain text</p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!body.trim() || sending}
            onClick={() => void handleSend()}
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Send className="h-4 w-4 mr-1.5" />
                Send
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Thread detail (messages + composer) ───────────────────────────────────

function ThreadDetail({ threadId }: { threadId: string }) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [retryBody, setRetryBody] = useState<string | undefined>(undefined);
  const { data, isLoading } = useQuery<{ messages: EmailMessage[] }>({
    queryKey: ["email-thread-messages", threadId],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/email/threads/${threadId}/messages`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to load messages");
      return r.json() as Promise<{ messages: EmailMessage[] }>;
    },
  });

  function openRetry(body: string) {
    setRetryBody(body);
    setComposerOpen(true);
  }

  function handleSent() {
    setComposerOpen(false);
    setRetryBody(undefined);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const messages = data?.messages ?? [];

  return (
    <div className="flex flex-col h-full">
      {/* Message list — scrollable */}
      <div className="flex-1 overflow-y-auto py-3 space-y-3 min-h-0">
        {messages.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">
            No messages in this thread.
          </p>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} onRetry={openRetry} />
          ))
        )}
      </div>

      {/* Reply area — pinned at bottom */}
      <div className="border-t pt-3 pb-2 space-y-2 shrink-0">
        {composerOpen ? (
          <ReplyComposer
            threadId={threadId}
            initialBody={retryBody}
            onClose={() => { setComposerOpen(false); setRetryBody(undefined); }}
            onSent={handleSent}
          />
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setComposerOpen(true)}
          >
            <CornerDownLeft className="h-4 w-4 mr-2" />
            Reply
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Main tab ───────────────────────────────────────────────────────────────

export function CommunicationsTab({ candidateId, emailV1Enabled }: Props) {
  const [selectedThread, setSelectedThread] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ threads: EmailThread[] }>({
    queryKey: ["email-threads", candidateId],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/candidates/${candidateId}/email-threads`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to load threads");
      return r.json() as Promise<{ threads: EmailThread[] }>;
    },
    enabled: emailV1Enabled,
  });

  if (!emailV1Enabled) {
    return (
      <div className="p-6 text-center text-muted-foreground text-sm border rounded-lg">
        Email, SMS, and call recording coming in Phase 4.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const threads = data?.threads ?? [];

  if (!threads.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-10 border rounded-lg text-center">
        <Mail className="h-10 w-10 text-muted-foreground/40" />
        <div className="space-y-1">
          <p className="font-medium text-foreground text-sm">No emails yet</p>
          <p className="text-sm text-muted-foreground">
            Connect your inbox to start syncing conversation history
          </p>
        </div>
        <Link href="/settings/email">
          <Button variant="outline" size="sm">
            <Inbox className="h-4 w-4 mr-2" />
            Connect inbox
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex gap-4 h-[500px]">
      {/* Thread list */}
      <div className="w-64 shrink-0 border rounded-lg overflow-y-auto">
        <div className="p-3 border-b">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Conversations
          </p>
        </div>
        <ul className="divide-y">
          {threads.map((thread) => (
            <li key={thread.id}>
              <button
                className={`w-full text-left px-3 py-3 hover:bg-muted/50 transition-colors flex items-start gap-2 ${
                  selectedThread === thread.id ? "bg-muted" : ""
                }`}
                onClick={() => setSelectedThread(thread.id)}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-sm font-medium truncate">{thread.subject}</p>
                  <div className="flex items-center gap-2">
                    {thread.messageCount > 0 && (
                      <Badge variant="secondary" className="text-xs h-4 px-1">
                        {thread.messageCount}
                      </Badge>
                    )}
                    {thread.lastMessageAt && (
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(thread.lastMessageAt), { addSuffix: true })}
                      </p>
                    )}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Message view */}
      <div className="flex-1 border rounded-lg overflow-hidden px-4 flex flex-col">
        {selectedThread ? (
          <ThreadDetail threadId={selectedThread} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Mail className="h-8 w-8 opacity-30" />
            <p className="text-sm">Select a conversation</p>
          </div>
        )}
      </div>
    </div>
  );
}
