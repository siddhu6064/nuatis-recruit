import { useAuth } from "@workspace/replit-auth-web";
import { Link } from "wouter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useQuery } from "@tanstack/react-query";

function useWorkspace() {
  return useQuery({
    queryKey: ["/api/workspace"],
    queryFn: async () => {
      const res = await fetch("/api/workspace", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch workspace");
      return res.json() as Promise<{ id: string; name: string; organizationId: string }>;
    },
  });
}

function getInitials(user: { email?: string | null; firstName?: string | null; lastName?: string | null }) {
  if (user.firstName || user.lastName) {
    return `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase();
  }
  return user.email?.[0]?.toUpperCase() ?? "?";
}

export function Nav() {
  const { user, logout } = useAuth();
  const { data: workspace } = useWorkspace();

  return (
    <header className="h-14 border-b border-border bg-white flex items-center px-6 gap-4">
      <div className="flex items-center gap-2 flex-1">
        <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center">
          <span className="text-primary-foreground text-xs font-bold">N</span>
        </div>
        <span className="font-semibold text-sm text-foreground">
          {workspace?.name ?? "Nuatis Recruit"}
        </span>
      </div>

      {user && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 rounded-full focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                  {getInitials(user)}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <div className="px-2 py-1.5">
              <p className="text-xs text-muted-foreground truncate">{user.email}</p>
              {user.role && (
                <p className="text-xs font-medium capitalize">{user.role}</p>
              )}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings/members" className="cursor-pointer">
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive cursor-pointer"
              onClick={logout}
            >
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </header>
  );
}
