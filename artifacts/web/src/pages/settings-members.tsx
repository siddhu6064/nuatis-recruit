import { useAuth } from "@workspace/replit-auth-web";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Nav } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Copy, Trash2, UserPlus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

type Member = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  lastActiveAt: string | null;
  createdAt: string;
};

type Invite = {
  id: string;
  email: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
};

function useMembersQuery() {
  return useQuery<{ members: Member[] }>({
    queryKey: ["/api/workspace/members"],
    queryFn: async () => {
      const res = await fetch("/api/workspace/members", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });
}

function useInvitesQuery(isOwner: boolean) {
  return useQuery<{ invites: Invite[] }>({
    queryKey: ["/api/workspace/invites"],
    enabled: isOwner,
    queryFn: async () => {
      const res = await fetch("/api/workspace/invites", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });
}

const ROLE_COLORS: Record<string, string> = {
  owner: "bg-primary/10 text-primary border-primary/20",
  recruiter: "bg-emerald-50 text-emerald-700 border-emerald-200",
  readonly: "bg-muted text-muted-foreground border-border",
};

export default function SettingsMembers() {
  const { user, isLoading, isAuthenticated, login } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState("");
  const [generatedInvite, setGeneratedInvite] = useState<{ token: string; inviteUrl: string } | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      login();
    }
  }, [isLoading, isAuthenticated, login]);

  const isOwner = user?.role === "owner";
  const { data: membersData, isLoading: membersLoading } = useMembersQuery();
  const { data: invitesData } = useInvitesQuery(isOwner);

  const createInviteMutation = useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch("/api/workspace/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to create invite");
      }
      return res.json() as Promise<{ token: string; inviteUrl: string }>;
    },
    onSuccess: (data) => {
      setGeneratedInvite(data);
      setInviteEmail("");
      queryClient.invalidateQueries({ queryKey: ["/api/workspace/invites"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: string }) => {
      const res = await fetch(`/api/workspace/members/${userId}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error("Failed to update role");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/workspace/members"] });
      toast({ title: "Role updated" });
    },
    onError: () => {
      toast({ title: "Error", description: "Could not update role", variant: "destructive" });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await fetch(`/api/workspace/members/${userId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to remove member");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/workspace/members"] });
      toast({ title: "Member removed" });
    },
    onError: () => {
      toast({ title: "Error", description: "Could not remove member", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isOwner && !isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="max-w-4xl mx-auto px-6 py-10">
          <div className="bg-white rounded-xl border border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">Only workspace owners can access this page.</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="max-w-4xl mx-auto px-6 py-10 space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Members</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage workspace members and invitations.</p>
        </div>

        {/* Generate invite link */}
        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <UserPlus className="h-4 w-4" />
              Invite Member
            </h2>
          </div>
          <div className="px-6 py-4 space-y-4">
            <div className="flex gap-3">
              <Input
                type="email"
                placeholder="teammate@company.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && inviteEmail) {
                    createInviteMutation.mutate(inviteEmail);
                  }
                }}
              />
              <Button
                onClick={() => createInviteMutation.mutate(inviteEmail)}
                disabled={!inviteEmail || createInviteMutation.isPending}
              >
                Generate link
              </Button>
            </div>

            {generatedInvite && (
              <div className="rounded-lg bg-muted px-4 py-3 flex items-center gap-3">
                <code className="text-xs flex-1 truncate text-foreground">
                  {generatedInvite.inviteUrl}
                </code>
                <button
                  className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                  onClick={() => {
                    navigator.clipboard.writeText(generatedInvite.inviteUrl);
                    toast({ title: "Copied to clipboard" });
                  }}
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Pending invites */}
        {invitesData && invitesData.invites.length > 0 && (
          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">Pending Invites</h2>
            </div>
            <div className="divide-y divide-border">
              {invitesData.invites.map((inv) => (
                <div key={inv.id} className="px-6 py-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">{inv.email}</p>
                    <p className="text-xs text-muted-foreground">
                      Expires {formatDistanceToNow(new Date(inv.expiresAt), { addSuffix: true })}
                    </p>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-medium">
                    Pending
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Members list */}
        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">All Members</h2>
            <span className="text-xs text-muted-foreground">
              {membersData?.members?.length ?? 0} member{(membersData?.members?.length ?? 0) !== 1 ? "s" : ""}
            </span>
          </div>

          {membersLoading ? (
            <div className="divide-y divide-border">
              {[1, 2].map((i) => (
                <div key={i} className="px-6 py-4 flex items-center gap-4">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-36" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-8 w-28" />
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {membersData?.members?.map((member) => (
                <div key={member.id} className="px-6 py-4 flex items-center gap-4">
                  <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-semibold text-primary">
                      {(member.name?.[0] ?? member.email?.[0] ?? "?").toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {member.name ?? member.email}
                    </p>
                    {member.name && (
                      <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {member.id !== user?.id ? (
                      <>
                        <Select
                          defaultValue={member.role}
                          onValueChange={(role) =>
                            updateRoleMutation.mutate({ userId: member.id, role })
                          }
                        >
                          <SelectTrigger className="w-28 h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="owner">Owner</SelectItem>
                            <SelectItem value="recruiter">Recruiter</SelectItem>
                            <SelectItem value="readonly">Read-only</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => removeMemberMutation.mutate(member.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    ) : (
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${ROLE_COLORS[member.role] ?? ROLE_COLORS.recruiter}`}>
                        {member.role} (you)
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
