/**
 * RLS middleware — sets the PostgreSQL session variable app.current_workspace_id
 * for authenticated requests so that the workspace isolation RLS policies
 * filter data to the caller's workspace automatically.
 *
 * Implementation:
 *  1. Acquires a pg PoolClient for the lifetime of the request.
 *  2. Opens a transaction (BEGIN).
 *  3. Uses a parameterized SET LOCAL so the value never touches string
 *     interpolation (SQL injection safe via pg's $1 protocol).
 *  4. Attaches a Drizzle instance over that specific client as req.db
 *     so route handlers issue queries inside the same transaction/context.
 *  5. Commits on response finish; rolls back on connection close before commit.
 *
 * Non-RLS escape hatch (TODO — do not add yet):
 *  Routes that legitimately need cross-workspace reads (e.g. global admin,
 *  super-tenant billing) should use a separate Pool created with a DB user
 *  that has the BYPASSRLS privilege. Import it as `adminDb` from a dedicated
 *  module — never use the shared `db` pool for such queries.
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
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    // Parameterized — workspaceId value is sent as a protocol parameter,
    // never interpolated into the SQL string.
    await client.query(
      "SELECT set_config('app.current_workspace_id', $1, true)",
      [workspaceId],
    );

    // Attach a Drizzle instance that routes through this specific client
    // (and thus through the same transaction + RLS context).
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
