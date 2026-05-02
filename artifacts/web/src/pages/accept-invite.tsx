import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { useToast } from "@/hooks/use-toast";

export default function AcceptInvite() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const { isLoading, isAuthenticated, login } = useAuth();
  const { toast } = useToast();
  const [status, setStatus] = useState<"pending" | "accepting" | "done" | "error">("pending");

  const params = new URLSearchParams(search);
  const token = params.get("token");

  useEffect(() => {
    if (isLoading) return;

    if (!isAuthenticated) {
      login();
      return;
    }

    if (!token) {
      navigate("/dashboard");
      return;
    }

    if (status !== "pending") return;

    setStatus("accepting");

    fetch("/api/workspace/invites/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error ?? "Invalid invite");
        }
        return res.json();
      })
      .then(() => {
        setStatus("done");
        toast({ title: "Welcome to the workspace!" });
        setTimeout(() => navigate("/dashboard"), 1500);
      })
      .catch((err: Error) => {
        setStatus("error");
        toast({ title: "Invite error", description: err.message, variant: "destructive" });
      });
  }, [isLoading, isAuthenticated, token, status, login, navigate, toast]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-center">
        {status === "error" ? (
          <>
            <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center">
              <span className="text-destructive font-bold">✕</span>
            </div>
            <p className="text-sm font-medium text-foreground">Invalid or expired invite</p>
            <button
              className="text-xs text-primary hover:underline"
              onClick={() => navigate("/dashboard")}
            >
              Go to dashboard
            </button>
          </>
        ) : status === "done" ? (
          <>
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
              <span className="text-emerald-600 font-bold">✓</span>
            </div>
            <p className="text-sm font-medium text-foreground">Joined workspace! Redirecting…</p>
          </>
        ) : (
          <>
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-muted-foreground">Accepting invite…</p>
          </>
        )}
      </div>
    </div>
  );
}
