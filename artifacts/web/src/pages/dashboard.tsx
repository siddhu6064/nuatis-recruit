import { useAuth } from "@workspace/replit-auth-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Nav } from "@/components/nav";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDistanceToNow } from "date-fns";

type Member = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  lastActiveAt: string | null;
  createdAt: string;
};

function useMembersQuery() {
  return useQuery<{ members: Member[] }>({
    queryKey: ["/api/workspace/members"],
    queryFn: async () => {
      const res = await fetch("/api/workspace/members", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch members");
      return res.json();
    },
  });
}

const ROLE_COLORS: Record<string, string> = {
  owner: "bg-primary/10 text-primary border-primary/20",
  recruiter: "bg-emerald-50 text-emerald-700 border-emerald-200",
  readonly: "bg-muted text-muted-foreground border-border",
};

export default function Dashboard() {
  const { user, isLoading, isAuthenticated, login } = useAuth();
  const { data, isLoading: membersLoading } = useMembersQuery();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      login();
    }
  }, [isLoading, isAuthenticated, login]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const displayName = user?.firstName
    ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ""}`
    : user?.email?.split("@")[0] ?? "there";

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="max-w-4xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-foreground">
            Welcome back, {displayName}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Here's your workspace overview.
          </p>
        </div>

        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Workspace Members</h2>
            <span className="text-xs text-muted-foreground">
              {data?.members?.length ?? 0} member{(data?.members?.length ?? 0) !== 1 ? "s" : ""}
            </span>
          </div>

          {membersLoading ? (
            <div className="divide-y divide-border">
              {[1, 2, 3].map((i) => (
                <div key={i} className="px-6 py-4 flex items-center gap-4">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-36" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {data?.members?.map((member) => (
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
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {member.lastActiveAt && (
                      <span className="text-xs text-muted-foreground hidden sm:block">
                        Active {formatDistanceToNow(new Date(member.lastActiveAt), { addSuffix: true })}
                      </span>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${ROLE_COLORS[member.role] ?? ROLE_COLORS.recruiter}`}>
                      {member.role}
                    </span>
                  </div>
                </div>
              ))}

              {data?.members?.length === 0 && (
                <div className="px-6 py-10 text-center">
                  <p className="text-sm text-muted-foreground">No members found.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
