/**
 * RLS middleware — sets PostgreSQL session variables for authenticated requests:
 *   app.current_workspace_id — workspace isolation for all tenant tables
 *   app.current_user_id      — user scoping for notifications table
 *
 * Both GUCs are set via parameterized SET LOCAL inside BEGIN/COMMIT, so values
 * are never string-interpolated into SQL (SQL injection safe).
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
  let committed = false;

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

    const commit = async () => {
      if (!committed) {
        committed = true;
        try {
          await client.query("COMMIT");
        } finally {
          client.release();
        }
      }
    };

    const rollback = async () => {
      if (!committed) {
        committed = true;
        try {
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
    };

    res.on("finish", () => void commit());
    res.on("close", () => void rollback());

    next();
  } catch (err) {
    if (!committed) {
      committed = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
    next(err);
  }
}
