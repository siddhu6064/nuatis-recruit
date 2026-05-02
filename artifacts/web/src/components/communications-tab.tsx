import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail, ChevronRight, Loader2, Inbox } from "lucide-react";
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
};

type Props = {
  candidateId: string;
  emailV1Enabled: boolean;
};

function MessageBubble({ message }: { message: EmailMessage }) {
  const isInbound = message.direction === "inbound";
  return (
    <div className={`flex ${isInbound ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 text-sm space-y-1 ${
          isInbound
            ? "bg-muted border"
            : "bg-primary text-primary-foreground"
        }`}
      >
        <p className="text-xs opacity-60 font-medium">
          {isInbound ? message.fromAddress : `You → ${message.toAddresses[0] ?? ""}`}
        </p>
        <p className="leading-relaxed whitespace-pre-wrap">{message.bodyText || "(no preview)"}</p>
        <p className="text-xs opacity-50 text-right">
          {message.sentAt
            ? formatDistanceToNow(new Date(message.sentAt), { addSuffix: true })
            : ""}
        </p>
      </div>
    </div>
  );
}

function ThreadDetail({ threadId }: { threadId: string }) {
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const messages = data?.messages ?? [];

  if (!messages.length) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No messages in this thread.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-3">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </div>
  );
}

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
      <div className="flex-1 border rounded-lg overflow-y-auto px-4">
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
