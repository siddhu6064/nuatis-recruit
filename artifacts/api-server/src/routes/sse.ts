/**
 * SSE endpoint for real-time application stage updates.
 *
 * GET /api/jobs/:id/stream
 *
 * Uses PostgreSQL LISTEN/NOTIFY ('applications_changed' channel).
 * Security: workspace_id in the NOTIFY payload is verified against the
 * authenticated user's workspace_id before forwarding any event.
 * Cross-workspace event forwarding is explicitly blocked.
 *
 * DEV-ONLY: GET /api/_test/sse-stream?workspace_id=X&job_id=Y
 * Accepts workspace_id from query param (no auth required) for tests.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import pg from "pg";
import { requireAuth } from "@workspace/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

type NotifyPayload = {
  workspace_id: string;
  job_id: string;
  application_id: string;
  action: string;
};

function setupSSE(req: Request, res: Response, workspaceId: string, jobId: string) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Dedicated pg client per SSE connection (pool connections can't LISTEN reliably)
  const pgClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  let closed = false;

  pgClient.connect().then(() => {
    return pgClient.query("LISTEN applications_changed");
  }).then(() => {
    // Send initial heartbeat
    res.write(`: connected\n\n`);

    pgClient.on("notification", (msg) => {
      if (!msg.payload) return;
      let payload: NotifyPayload;
      try {
        payload = JSON.parse(msg.payload) as NotifyPayload;
      } catch {
        return;
      }

      // Security: only forward events for the authenticated user's workspace
      if (payload.workspace_id !== workspaceId) return;
      // Filter to the requested job
      if (payload.job_id !== jobId) return;

      if (!closed) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    });

    // Heartbeat every 20s to keep connection alive
    const heartbeat = setInterval(() => {
      if (!closed) res.write(`: heartbeat\n\n`);
    }, 20_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      pgClient.end().catch(() => {/* ignore */});
    };

    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("close", cleanup);
  }).catch((err) => {
    logger.error({ err, workspaceId, jobId }, "SSE pg client connect failed");
    if (!closed) {
      closed = true;
      res.write(`event: error\ndata: ${JSON.stringify({ error: "connection failed" })}\n\n`);
      res.end();
    }
    pgClient.end().catch(() => {/* ignore */});
  });
}

// GET /api/jobs/:id/stream — authenticated SSE
router.get("/jobs/:id/stream", (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const jobId = String(req.params.id);
  setupSSE(req, res, user.workspaceId, jobId);
});

// Dev-only test SSE endpoint (no auth required; workspace_id from query param)
if (process.env.NODE_ENV !== "production") {
  router.get("/_test/sse-stream", (req: Request, res: Response) => {
    const workspaceId = String(req.query.workspace_id ?? "");
    const jobId = String(req.query.job_id ?? "");
    if (!workspaceId || !jobId) {
      res.status(400).json({ error: "workspace_id and job_id are required" });
      return;
    }
    setupSSE(req, res, workspaceId, jobId);
  });
}

export default router;
