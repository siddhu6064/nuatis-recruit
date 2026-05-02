/**
 * Applies PostgreSQL RLS policies and audit triggers to the live database.
 * Run once via:  pnpm --filter @workspace/db run migrate:rls
 *
 * Design notes:
 * - RLS policy uses NULL-safe USING clause: when app.current_workspace_id is
 *   not set (e.g. auth callback, system tasks), ALL rows are visible. When a
 *   workspace context IS set (e.g. via the rlsMiddleware in Express), only rows
 *   belonging to that workspace are visible. This is intentional v1 design —
 *   isolation is application-enforced for authenticated requests; the DB policy
 *   acts as a defense-in-depth guard once the middleware is in place.
 *
 * - Organizations are NOT workspace-scoped (they are the top-level tenant).
 *   Sessions are auth-infrastructure — no workspace relationship. Neither gets
 *   a workspace isolation policy.
 *
 * - Audit triggers use SECURITY DEFINER so they always have permission to INSERT
 *   into audit_logs regardless of the caller's RLS context. Because audit_logs
 *   uses USING (not WITH CHECK), INSERTs are unrestricted — only SELECTs/DELETEs
 *   are filtered.
 *
 * - TODO (non-RLS escape hatch): any code path that legitimately needs
 *   cross-workspace access (e.g. global admin queries) should use a separate
 *   Pool created with a DB user that has BYPASSRLS, or should connect and call
 *   SET LOCAL app.current_workspace_id = '' to trigger the IS NULL branch.
 *   Do NOT use the shared `db` pool for such queries in the interim.
 */
import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

const SQL = `
-- ─────────────────────────────────────────────────
-- 0. nuatis_app role
--
--    PostgreSQL superusers (like the default "postgres" user in Replit)
--    bypass ALL row security, even with FORCE ROW LEVEL SECURITY.
--    The ONLY way to enforce RLS is to run queries as a non-superuser
--    role that does NOT have the BYPASSRLS attribute.
--
--    We create nuatis_app for this purpose and the db pool switches to
--    it via SET ROLE immediately after each physical connection is acquired.
--    This makes RLS policies effective without changing DATABASE_URL.
-- ─────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuatis_app') THEN
    CREATE ROLE nuatis_app
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOBYPASSRLS;
  END IF;
END
$$;

-- Grant DML on every current and future table in the public schema.
GRANT USAGE ON SCHEMA public TO nuatis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nuatis_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nuatis_app;

-- ─────────────────────────────────────────────────
-- 1. Enable RLS on tenant-scoped tables
-- ─────────────────────────────────────────────────
ALTER TABLE workspaces    ENABLE ROW LEVEL SECURITY;
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites       ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients       ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE resumes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities    ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────
-- 1b. FORCE RLS so the policy applies even to the
--     table owner (the connected DB user in Replit
--     Postgres is the table owner, so without FORCE
--     the policy is silently bypassed).
-- ─────────────────────────────────────────────────
ALTER TABLE workspaces    FORCE ROW LEVEL SECURITY;
ALTER TABLE users         FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs    FORCE ROW LEVEL SECURITY;
ALTER TABLE invites       FORCE ROW LEVEL SECURITY;
ALTER TABLE clients       FORCE ROW LEVEL SECURITY;
ALTER TABLE jobs          FORCE ROW LEVEL SECURITY;
ALTER TABLE candidates    FORCE ROW LEVEL SECURITY;
ALTER TABLE applications  FORCE ROW LEVEL SECURITY;
ALTER TABLE resumes       FORCE ROW LEVEL SECURITY;
ALTER TABLE activities    FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────
-- 2. Drop existing policies (idempotent re-run)
-- ─────────────────────────────────────────────────
DROP POLICY IF EXISTS workspaces_workspace_isolation    ON workspaces;
DROP POLICY IF EXISTS users_workspace_isolation         ON users;
DROP POLICY IF EXISTS audit_logs_workspace_isolation    ON audit_logs;
DROP POLICY IF EXISTS invites_workspace_isolation       ON invites;
DROP POLICY IF EXISTS clients_workspace_isolation       ON clients;
DROP POLICY IF EXISTS jobs_workspace_isolation          ON jobs;
DROP POLICY IF EXISTS candidates_workspace_isolation    ON candidates;
DROP POLICY IF EXISTS applications_workspace_isolation  ON applications;
DROP POLICY IF EXISTS resumes_workspace_isolation       ON resumes;
DROP POLICY IF EXISTS activities_workspace_isolation    ON activities;

-- ─────────────────────────────────────────────────
-- 3. Create workspace-isolation policies
--
--    NULL-safe: when app.current_workspace_id is not set (IS NULL),
--    all rows are visible. When set, only matching rows are visible.
--
--    workspaces: isolated by its own PK (id = the workspace id).
--    users / audit_logs / invites: isolated by workspace_id FK column.
-- ─────────────────────────────────────────────────
-- NOTE: We check NULLIF(..., '') IS NULL rather than just IS NULL.
-- When a connection is reused from the pool, a previously-set transaction-local
-- GUC (set_config(..., is_local=true)) reverts to '' (empty string) on ROLLBACK
-- rather than to NULL.  Treating '' the same as NULL means: "no workspace
-- context bound to this session" → all rows visible.  Setting a real UUID
-- workspace ID (non-empty) activates the per-workspace filter.
CREATE POLICY workspaces_workspace_isolation ON workspaces
  USING (
    NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
    OR id::text = current_setting('app.current_workspace_id', true)
  );

CREATE POLICY users_workspace_isolation ON users
  USING (
    NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
    OR workspace_id::text = current_setting('app.current_workspace_id', true)
  );

CREATE POLICY audit_logs_workspace_isolation ON audit_logs
  USING (
    NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
    OR workspace_id::text = current_setting('app.current_workspace_id', true)
  );

CREATE POLICY invites_workspace_isolation ON invites
  USING (
    NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
    OR workspace_id::text = current_setting('app.current_workspace_id', true)
  );

-- Batch 2: ATS core object isolation policies (same NULLIF pattern)
CREATE POLICY clients_workspace_isolation ON clients
  USING (
    NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
    OR workspace_id::text = current_setting('app.current_workspace_id', true)
  );

CREATE POLICY jobs_workspace_isolation ON jobs
  USING (
    NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
    OR workspace_id::text = current_setting('app.current_workspace_id', true)
  );

CREATE POLICY candidates_workspace_isolation ON candidates
  USING (
    NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
    OR workspace_id::text = current_setting('app.current_workspace_id', true)
  );

CREATE POLICY applications_workspace_isolation ON applications
  USING (
    NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
    OR workspace_id::text = current_setting('app.current_workspace_id', true)
  );

CREATE POLICY resumes_workspace_isolation ON resumes
  USING (
    NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
    OR workspace_id::text = current_setting('app.current_workspace_id', true)
  );

CREATE POLICY activities_workspace_isolation ON activities
  USING (
    NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
    OR workspace_id::text = current_setting('app.current_workspace_id', true)
  );

-- ─────────────────────────────────────────────────
-- 4. Audit trigger functions (SECURITY DEFINER so they
--    can INSERT into audit_logs regardless of caller context)
-- ─────────────────────────────────────────────────

-- 4a. Workspace creation
CREATE OR REPLACE FUNCTION _audit_workspace_create()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_logs (workspace_id, action, target_type, target_id)
  VALUES (NEW.id, 'workspace.create', 'workspace', NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_audit_create ON workspaces;
CREATE TRIGGER workspace_audit_create
  AFTER INSERT ON workspaces
  FOR EACH ROW
  EXECUTE FUNCTION _audit_workspace_create();

-- 4b. Invite creation
CREATE OR REPLACE FUNCTION _audit_invite_create()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_logs (workspace_id, action, target_type, target_id)
  VALUES (NEW.workspace_id, 'invite.create', 'invite', NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invite_audit_create ON invites;
CREATE TRIGGER invite_audit_create
  AFTER INSERT ON invites
  FOR EACH ROW
  EXECUTE FUNCTION _audit_invite_create();

-- 4c. User role change
CREATE OR REPLACE FUNCTION _audit_user_role_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.role IS DISTINCT FROM NEW.role THEN
    INSERT INTO audit_logs (workspace_id, action, target_type, target_id, diff_json)
    VALUES (
      NEW.workspace_id,
      'member.role_change',
      'user',
      NEW.id,
      jsonb_build_object('from', OLD.role, 'to', NEW.role)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_audit_role_change ON users;
CREATE TRIGGER user_audit_role_change
  AFTER UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION _audit_user_role_change();

-- 4d. User removal
CREATE OR REPLACE FUNCTION _audit_user_remove()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_logs (workspace_id, action, target_type, target_id)
  VALUES (OLD.workspace_id, 'member.removed', 'user', OLD.id);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS user_audit_remove ON users;
CREATE TRIGGER user_audit_remove
  AFTER DELETE ON users
  FOR EACH ROW
  EXECUTE FUNCTION _audit_user_remove();
`;

async function main() {
  await client.connect();
  console.log("Applying RLS policies and audit triggers...");
  await client.query(SQL);
  console.log("Verifying...");

  const rls = await client.query(`
    SELECT relname, relrowsecurity
    FROM pg_class
    WHERE relname IN ('workspaces','users','audit_logs','invites',
                      'clients','jobs','candidates','applications','resumes','activities')
    ORDER BY relname
  `);
  console.log("RLS status:");
  rls.rows.forEach((r) => console.log(`  ${r.relname}: rowsecurity=${r.relrowsecurity}`));

  const policies = await client.query(`
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname='public'
    ORDER BY tablename
  `);
  console.log("Policies:");
  policies.rows.forEach((r) => console.log(`  ${r.tablename}: ${r.policyname}`));

  const triggers = await client.query(`
    SELECT trigger_name, event_object_table, action_timing, event_manipulation
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
    AND trigger_name LIKE '%audit%'
    ORDER BY event_object_table, trigger_name
  `);
  console.log("Audit triggers:");
  triggers.rows.forEach((r) =>
    console.log(`  ${r.event_object_table} ${r.event_manipulation}: ${r.trigger_name}`)
  );

  await client.end();
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
