import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@workspace/replit-auth-web";
import { useEffect } from "react";
import Dashboard from "@/pages/dashboard";
import SettingsMembers from "@/pages/settings-members";
import SettingsEmail from "@/pages/settings-email";
import AcceptInvite from "@/pages/accept-invite";
import NotFound from "@/pages/not-found";
import Clients from "@/pages/clients";
import ClientDetail from "@/pages/client-detail";
import Jobs from "@/pages/jobs";
import JobDetail from "@/pages/job-detail";
import Candidates from "@/pages/candidates";
import CandidateDetail from "@/pages/candidate-detail";
import Search from "@/pages/search";
import Tasks from "@/pages/tasks";
import SettingsEmailTemplates from "@/pages/settings-email-templates";

const queryClient = new QueryClient();

function HomeRedirect() {
  const { isLoading, isAuthenticated, login } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!isLoading) {
      if (isAuthenticated) {
        navigate("/dashboard");
      } else {
        login();
      }
    }
  }, [isLoading, isAuthenticated, login, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeRedirect} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/clients" component={Clients} />
      <Route path="/clients/:id" component={ClientDetail} />
      <Route path="/jobs" component={Jobs} />
      <Route path="/jobs/:id" component={JobDetail} />
      <Route path="/candidates" component={Candidates} />
      <Route path="/candidates/:id" component={CandidateDetail} />
      <Route path="/search" component={Search} />
      <Route path="/tasks" component={Tasks} />
      <Route path="/settings/members" component={SettingsMembers} />
      <Route path="/settings/email" component={SettingsEmail} />
      <Route path="/settings/email-templates" component={SettingsEmailTemplates} />
      <Route path="/accept-invite" component={AcceptInvite} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
