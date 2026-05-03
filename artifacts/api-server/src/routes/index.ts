import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import workspaceRouter from "./workspace";
import clientsRouter from "./clients";
import jobsRouter from "./jobs";
import candidatesRouter from "./candidates";
import applicationsRouter from "./applications";
import publicRouter from "./public";
import matchScoresRouter from "./match-scores";
import rejectionReasonsRouter from "./rejection-reasons";
import sseRouter from "./sse";
import notesRouter from "./notes";
import tasksRouter from "./tasks";
import notificationsRouter from "./notifications";
import searchRouter from "./search";
import savedSearchesRouter from "./saved-searches";
import emailRouter from "./email";
import emailAuthRouter from "./email-auth";
import emailAccountsRouter from "./email-accounts";
import emailTemplatesRouter from "./email-templates";
import postmarkWebhookRouter from "./webhooks/postmark";
import nylasWebhookRouter from "./webhooks/nylas";
import { inngestHandler } from "./inngest-serve";
import { inngest } from "../lib/inngest";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  createSession,
  SESSION_COOKIE,
  SESSION_TTL,
  type SessionData,
} from "../lib/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(workspaceRouter);
router.use(clientsRouter);
router.use(jobsRouter);
router.use(searchRouter);
router.use(savedSearchesRouter);
router.use(candidatesRouter);
router.use(applicationsRouter);
router.use(publicRouter);
router.use(matchScoresRouter);
router.use(rejectionReasonsRouter);
router.use(sseRouter);
router.use(notesRouter);
router.use(tasksRouter);
router.use(notificationsRouter);
router.use(emailRouter);
router.use(emailAuthRouter);
router.use(emailAccountsRouter);
router.use(emailTemplatesRouter);
router.use(postmarkWebhookRouter);
router.use(nylasWebhookRouter);

// Inngest serve endpoint
router.use("/inngest", inngestHandler);

// Dev-only: fire an Inngest event via SDK (used by E2E tests)
if (process.env.NODE_ENV !== "production") {
  router.post("/_test/inngest-send", async (req, res) => {
    try {
      const { name, data } = req.body as { name: string; data: Record<string, unknown> };
      if (!name) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      await inngest.send({ name, data: data ?? {} });
      res.json({ ok: true, event: name });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Dev-only: create a test session cookie for a given workspaceId + userId
  // Used by kanban integration tests to authenticate without real OIDC flow.
  router.post("/_test/session", async (req, res) => {
    try {
      const { workspaceId, userId } = req.body as {
        workspaceId?: string;
        userId?: string;
      };
      if (!workspaceId || !userId) {
        res.status(400).json({ error: "workspaceId and userId are required" });
        return;
      }

      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, userId));

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const sessionData: SessionData = {
        user: {
          id: user.id,
          email: user.email,
          firstName: null,
          lastName: null,
          profileImageUrl: null,
          workspaceId: user.workspaceId ?? workspaceId,
          role: user.role ?? "recruiter",
        },
        access_token: "test-token",
        refresh_token: undefined,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };

      const sid = await createSession(sessionData);
      res.cookie(SESSION_COOKIE, sid, {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_TTL,
      });
      res.json({ ok: true, sid });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}

export default router;
