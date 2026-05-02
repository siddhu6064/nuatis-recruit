import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

// Create a pool that switches to nuatis_app role on every connection.
// The default Replit Postgres user is "postgres" — a superuser — which
// PostgreSQL always exempts from RLS policies. By switching to nuatis_app
// (a non-superuser, non-BYPASSRLS role with full DML grants), we make the
// workspace isolation policies effective in tests exactly as they are at
// runtime.  This is the same technique used in lib/db/src/index.ts.
const _rawPool = new Pool({ connectionString: process.env.DATABASE_URL });
const _originalConnect = _rawPool.connect.bind(_rawPool);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(_rawPool as any).connect = async function (...args: any[]) {
  if (args.length > 0 && typeof args[0] === "function") {
    return _originalConnect(...(args as Parameters<typeof _originalConnect>));
  }
  const client = await _originalConnect();
  try {
    await client.query("SET ROLE nuatis_app");
  } catch (err) {
    client.release();
    throw new Error(
      `SET ROLE nuatis_app failed — run "pnpm --filter @workspace/db run migrate:rls" first. (${String(err)})`,
    );
  }
  return client;
};

export const pool = _rawPool as pg.Pool;

/** Run a callback inside a fresh client (useful for RLS / SET LOCAL) */
export async function withClient<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Clean up rows inserted by tests using a specific marker prefix */
export async function cleanTestData(prefix: string) {
  const client = await pool.connect();
  try {
    // Delete in FK-safe order
    await client.query(
      `DELETE FROM invites WHERE email LIKE $1`,
      [`${prefix}%`],
    );
    await client.query(
      `DELETE FROM audit_logs WHERE target_type = 'test' AND ip = $1`,
      [prefix],
    );
    const wsResult = await client.query(
      `SELECT w.id FROM workspaces w
       JOIN organizations o ON o.id = w.organization_id
       WHERE o.slug LIKE $1`,
      [`${prefix}%`],
    );
    const wsIds = wsResult.rows.map((r: { id: string }) => r.id);
    if (wsIds.length) {
      // Batch 5: notifications + notes (FK on users/candidates) + tasks + saved_searches
      await client.query(`DELETE FROM notifications  WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await client.query(`DELETE FROM notes          WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await client.query(`DELETE FROM tasks          WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await client.query(`DELETE FROM saved_searches WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      // Batch 4: delete kanban support tables first
      await client.query(`DELETE FROM stage_automations WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await client.query(`DELETE FROM rejection_reasons  WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      // Batch 3: delete leaf tables first (FK deps on applications/candidates/jobs)
      await client.query(`DELETE FROM match_scores       WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await client.query(`DELETE FROM fairness_audit_log WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      // Batch 2: delete in FK-safe order
      await client.query(`DELETE FROM activities         WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await client.query(`DELETE FROM resumes            WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await client.query(`DELETE FROM applications       WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await client.query(`DELETE FROM candidates         WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await client.query(`DELETE FROM jobs               WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await client.query(`DELETE FROM clients            WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      // Batch 1
      await client.query(`DELETE FROM users              WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await client.query(`DELETE FROM invites            WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await client.query(`DELETE FROM audit_logs         WHERE workspace_id = ANY($1::uuid[])`, [wsIds]);
      await client.query(`DELETE FROM workspaces         WHERE id = ANY($1::uuid[])`, [wsIds]);
    }
    await client.query(
      `DELETE FROM organizations WHERE slug LIKE $1`,
      [`${prefix}%`],
    );
  } finally {
    client.release();
  }
}

/** Create an org + workspace + owner user, return their IDs */
export async function createTestTenant(
  prefix: string,
  suffix: string,
): Promise<{ orgId: string; workspaceId: string; userId: string }> {
  const client = await pool.connect();
  try {
    const orgResult = await client.query(
      `INSERT INTO organizations (name, slug)
       VALUES ($1, $2)
       RETURNING id`,
      [`${prefix} Org ${suffix}`, `${prefix}-org-${suffix}`],
    );
    const orgId: string = orgResult.rows[0].id;

    const wsResult = await client.query(
      `INSERT INTO workspaces (organization_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [orgId, `${prefix} Workspace ${suffix}`],
    );
    const workspaceId: string = wsResult.rows[0].id;

    const userResult = await client.query(
      `INSERT INTO users (workspace_id, external_auth_id, external_auth_provider, email, role)
       VALUES ($1, $2, 'test', $3, 'owner')
       RETURNING id`,
      [workspaceId, `test-ext-${prefix}-${suffix}`, `${prefix}+${suffix}@test.invalid`],
    );
    const userId: string = userResult.rows[0].id;

    return { orgId, workspaceId, userId };
  } finally {
    client.release();
  }
}

export async function teardown() {
  await pool.end();
}
