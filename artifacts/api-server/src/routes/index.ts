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

export default router;
