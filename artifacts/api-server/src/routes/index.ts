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
import { inngestHandler } from "./inngest-serve";
import { inngest } from "../lib/inngest";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(workspaceRouter);
router.use(clientsRouter);
router.use(jobsRouter);
router.use(candidatesRouter);
router.use(applicationsRouter);
router.use(publicRouter);
router.use(matchScoresRouter);

// Inngest serve endpoint — Inngest dev server / cloud polls this to discover functions
router.use("/inngest", inngestHandler);

// Dev-only: fire an Inngest event via SDK (used by E2E tests to seed events
// for jobs seeded directly in the DB rather than through the API route)
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
}

export default router;
