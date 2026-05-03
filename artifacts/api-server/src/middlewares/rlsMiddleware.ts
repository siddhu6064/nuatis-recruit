/**
 * RLS middleware — sets PostgreSQL session variables for authenticated requests:
 *   app.current_workspace_id — workspace isolation for all tenant tables
 *   app.current_user_id      — user scoping for notifications table
 *
 * Both GUCs are set via parameterized SET LOCAL inside BEGIN/COMMIT, so values
 * are never string-interpolated into SQL (SQL injection safe).
 *
 * COMMIT STRATEGY: We commit on the "finish" event (after response headers are
 * flushed) and roll back on the "close" event (client disconnect before finish).
 * A `done` flag ensures only one of commit/rollback fires per request.
 */
import type { Request, Response, NextFunction } from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "@workspace/db";
import type { Pool } from "pg";
import * as schema from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      /** Drizzle instance scoped to the current request's RLS transaction. */
      db?: ReturnType<typeof drizzle>;
    }
  }
}

export async function rlsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.isAuthenticated() || !req.user?.workspaceId) {
    next();
    return;
  }

  const workspaceId = req.user.workspaceId;
  const userId = req.user.id;
  const client = await pool.connect();
  let done = false;

  const commit = async () => {
    if (!done) {
      done = true;
      try {
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    }
  };

  const rollback = async () => {
    if (!done) {
      done = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  };

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.current_workspace_id', $1, true)",
      [workspaceId],
    );
    await client.query(
      "SELECT set_config('app.current_user_id', $1, true)",
      [userId],
    );

    req.db = drizzle(client as unknown as Pool, { schema });

    res.on("finish", () => void commit());
    res.on("close", () => void rollback());

    next();
  } catch (err) {
    await rollback();
    next(err);
  }
}
