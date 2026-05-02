/**
 * DB pool + Drizzle instance.
 *
 * The pool overrides `connect()` to run `SET ROLE nuatis_app` immediately after
 * acquiring a physical connection. This switches from the `postgres` superuser
 * (which PostgreSQL always exempts from RLS, even with FORCE ROW LEVEL SECURITY)
 * to the `nuatis_app` role (non-superuser, no BYPASSRLS) so that the workspace
 * isolation policies are actually enforced for every query that goes through this
 * pool, including those in the test suite.
 *
 * `SET ROLE` is session-scoped — it persists for the life of the physical
 * connection, so it only needs to be run once per new connection. Subsequent
 * `pool.connect()` calls that reuse the same physical connection are harmless
 * (running `SET ROLE nuatis_app` again is idempotent).
 *
 * Operations that legitimately need the superuser (DDL migrations, drizzle-kit
 * push) use a direct pg.Client with the DATABASE_URL and are NOT routed through
 * this pool.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const _pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Override connect() to enforce non-superuser role so that PostgreSQL RLS
// policies are applied. The postgres superuser bypasses all RLS policies;
// nuatis_app is a constrained role that obeys them.
const _originalConnect = _pool.connect.bind(_pool);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(_pool as any).connect = async function (...args: any[]) {
  if (args.length > 0 && typeof args[0] === "function") {
    // Callback form — not used in this codebase but keep it compatible.
    return _originalConnect(...(args as Parameters<typeof _originalConnect>));
  }
  const client = await _originalConnect();
  try {
    await client.query("SET ROLE nuatis_app");
  } catch (err) {
    client.release();
    throw new Error(
      `SET ROLE nuatis_app failed — has "pnpm --filter @workspace/db run migrate:rls" been run? (${String(err)})`,
    );
  }
  return client;
};

export const pool = _pool as pg.Pool;
export const db = drizzle(pool, { schema });

export * from "./schema";
