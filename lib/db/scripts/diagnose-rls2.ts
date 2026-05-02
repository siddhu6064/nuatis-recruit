/**
 * Mirrors EXACTLY what the RLS test does: creates two tenants, sets workspace A
 * context, queries workspace B users, expects 0.
 */
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Create two test workspaces + users directly via SQL (same as createTestTenant)
  const setup = await pool.connect();
  try {
    await setup.query("BEGIN");

    // Org A
    const orgA = await setup.query(
      "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
      ["Diag Org A", "diag-org-a-" + Date.now()],
    );
    const wsA = await setup.query(
      "INSERT INTO workspaces (organization_id, name) VALUES ($1, $2) RETURNING id",
      [orgA.rows[0].id, "Diag WS A"],
    );
    await setup.query(
      "INSERT INTO users (workspace_id, external_auth_id, external_auth_provider, email, role) VALUES ($1, $2, 'test', $3, 'owner')",
      [wsA.rows[0].id, "diag-user-a", "diag-a@test.invalid"],
    );

    // Org B
    const orgB = await setup.query(
      "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
      ["Diag Org B", "diag-org-b-" + Date.now()],
    );
    const wsB = await setup.query(
      "INSERT INTO workspaces (organization_id, name) VALUES ($1, $2) RETURNING id",
      [orgB.rows[0].id, "Diag WS B"],
    );
    await setup.query(
      "INSERT INTO users (workspace_id, external_auth_id, external_auth_provider, email, role) VALUES ($1, $2, 'test', $3, 'owner')",
      [wsB.rows[0].id, "diag-user-b", "diag-b@test.invalid"],
    );

    await setup.query("COMMIT");

    const wsAId = wsA.rows[0].id as string;
    const wsBId = wsB.rows[0].id as string;
    console.log("workspace A:", wsAId);
    console.log("workspace B:", wsBId);

    // NOW mirror the RLS test exactly
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.current_workspace_id', $1, true)",
        [wsAId],
      );
      const ctxCheck = await client.query(
        "SELECT current_setting('app.current_workspace_id', true) as ctx",
      );
      console.log("Context in tx:", ctxCheck.rows[0].ctx);

      const noRlsCheck = await client.query("SELECT count(*) FROM users");
      console.log("Total users visible in tx (should be 1 if RLS works):", noRlsCheck.rows[0].count);

      const res = await client.query(
        "SELECT * FROM users WHERE workspace_id = $1",
        [wsBId],
      );
      console.log("Workspace B users when context=workspaceA (expect 0, got):", res.rows.length);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    // Cleanup
    await setup.query("DELETE FROM users WHERE email IN ('diag-a@test.invalid', 'diag-b@test.invalid')");
    await setup.query("DELETE FROM workspaces WHERE name IN ('Diag WS A', 'Diag WS B')");
    await setup.query("DELETE FROM organizations WHERE name IN ('Diag Org A', 'Diag Org B')");
  } finally {
    setup.release();
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
