import pg from "pg";
const { Client } = pg;

const c = new Client({ connectionString: process.env.DATABASE_URL });

async function main() {
  await c.connect();

  const r1 = await c.query(
    "SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user",
  );
  console.log("User/superuser:", JSON.stringify(r1.rows[0]));

  const r2 = await c.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity
     FROM pg_class
     WHERE relname IN ('users','workspaces','audit_logs','invites')
     ORDER BY relname`,
  );
  console.log("Table RLS flags:", JSON.stringify(r2.rows));

  const r3 = await c.query(
    `SELECT tablename, policyname, qual
     FROM pg_policies WHERE schemaname='public' AND tablename='users'`,
  );
  console.log("users policy:", JSON.stringify(r3.rows));

  await c.query("BEGIN");
  await c.query(
    "SELECT set_config('app.current_workspace_id', 'test-id', true)",
  );
  const r4 = await c.query(
    "SELECT current_setting('app.current_workspace_id', true) as val",
  );
  console.log("current_setting in tx:", JSON.stringify(r4.rows));
  const r5 = await c.query("SELECT count(*) FROM users");
  console.log("row count in tx (with fake context):", JSON.stringify(r5.rows));
  await c.query("ROLLBACK");

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
