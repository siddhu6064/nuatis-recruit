/**
 * Vitest global teardown — runs once after ALL test files complete.
 * Ends the shared pg.Pool so the process exits cleanly.
 */
import { pool } from "./db";

export default async function globalTeardown() {
  await pool.end();
}
