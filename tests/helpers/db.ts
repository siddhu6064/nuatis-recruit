import pg from "pg";

const { Pool, Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

// Shared pool for non-RLS queries
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
      await client.query(
        `DELETE FROM users WHERE workspace_id = ANY($1::uuid[])`,
        [wsIds],
      );
      await client.query(
        `DELETE FROM invites WHERE workspace_id = ANY($1::uuid[])`,
        [wsIds],
      );
      await client.query(
        `DELETE FROM audit_logs WHERE workspace_id = ANY($1::uuid[])`,
        [wsIds],
      );
      await client.query(
        `DELETE FROM workspaces WHERE id = ANY($1::uuid[])`,
        [wsIds],
      );
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
