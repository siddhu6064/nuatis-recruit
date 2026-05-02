import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useLocation } from "wouter";
import { Nav } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Mail, Link2Off, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@workspace/replit-auth-web";

type ConnectedAccount = {
  id: string;
  provider: "gmail" | "outlook" | "imap";
  emailAddress: string;
  status: "active" | "revoked" | "error";
  connectedAt: string | null;
  lastSyncAt: string | null;
  userId: string;
};

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function ProviderBadge({ provider }: { provider: ConnectedAccount["provider"] }) {
  const labels: Record<ConnectedAccount["provider"], string> = {
    gmail: "Gmail",
    outlook: "Outlook",
    imap: "IMAP",
  };
  return (
    <Badge variant="secondary" className="text-xs">
      {labels[provider]}
    </Badge>
  );
}

function StatusBadge({ status }: { status: ConnectedAccount["status"] }) {
  if (status === "active") {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-600">
        <CheckCircle2 className="h-3 w-3" /> Active
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive">
        <AlertCircle className="h-3 w-3" /> Error — reconnect required
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">Disconnected</span>;
}

export default function SettingsEmail() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [location] = useLocation();

  // Surface success/error from OAuth redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("success") === "connected") {
      toast({ title: "Inbox connected", description: "Your email inbox is now syncing." });
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.get("error")) {
      toast({
        title: "Connection failed",
        description: `OAuth error: ${params.get("error")}. Please try again.`,
        variant: "destructive",
      });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [location]);

  const { data, isLoading } = useQuery<{ accounts: ConnectedAccount[] }>({
    queryKey: ["email-accounts"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/email/accounts`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to fetch connected accounts");
      return r.json() as Promise<{ accounts: ConnectedAccount[] }>;
    },
  });

  const disconnect = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`${BASE}/api/email/accounts/${id}/disconnect`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to disconnect");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["email-accounts"] });
      toast({ title: "Inbox disconnected" });
    },
    onError: () => {
      toast({ title: "Disconnect failed", variant: "destructive" });
    },
  });

  function handleConnect() {
    window.location.href = `${BASE}/api/email/auth/start`;
  }

  const accounts = data?.accounts ?? [];

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Email Settings</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Connect your inbox to sync candidate conversations.
            </p>
          </div>
          <Button onClick={handleConnect} size="sm">
            <Mail className="h-4 w-4 mr-2" />
            Connect inbox
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connected inboxes</CardTitle>
            <CardDescription>
              Inbound emails from candidates are synced automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : accounts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
                <Mail className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No inboxes connected yet.</p>
                <Button variant="outline" size="sm" onClick={handleConnect}>
                  Connect your first inbox
                </Button>
              </div>
            ) : (
              <ul className="divide-y">
                {accounts.map((acc) => (
                  <li key={acc.id} className="flex items-center justify-between py-3">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{acc.emailAddress}</span>
                        <ProviderBadge provider={acc.provider} />
                      </div>
                      <StatusBadge status={acc.status} />
                      {acc.lastSyncAt && (
                        <p className="text-xs text-muted-foreground">
                          Last synced{" "}
                          {new Date(acc.lastSyncAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      disabled={disconnect.isPending}
                      onClick={() => disconnect.mutate(acc.id)}
                    >
                      <Link2Off className="h-4 w-4 mr-1.5" />
                      Disconnect
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
