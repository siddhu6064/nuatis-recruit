/**
 * Applies PostgreSQL RLS policies, audit triggers, NOTIFY triggers, and
 * seeding triggers to the live database.
 * Run once via:  pnpm --filter @workspace/db run migrate:rls
 * Idempotent — safe to re-run.
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
-- ─────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuatis_app') THEN
    CREATE ROLE nuatis_app
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO nuatis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nuatis_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nuatis_app;

-- ─────────────────────────────────────────────────
-- 1. Batch 4 schema additions (idempotent)
-- ─────────────────────────────────────────────────

-- 1a. jobs.stages_json
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'jobs' AND column_name = 'stages_json'
  ) THEN
    ALTER TABLE jobs ADD COLUMN stages_json jsonb NOT NULL DEFAULT '[
      {"key":"sourced",  "label":"Sourced",   "order":0},
      {"key":"applied",  "label":"Applied",   "order":1},
      {"key":"screen",   "label":"Screen",    "order":2},
      {"key":"hm_round", "label":"HM Round",  "order":3},
      {"key":"final",    "label":"Final",     "order":4},
      {"key":"offer",    "label":"Offer",     "order":5},
      {"key":"placed",   "label":"Placed",    "order":6},
      {"key":"rejected", "label":"Rejected",  "order":7}
    ]'::jsonb;
  END IF;
END
$$;

-- 1b. applications.position_in_stage
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'applications' AND column_name = 'position_in_stage'
  ) THEN
    ALTER TABLE applications ADD COLUMN position_in_stage int NOT NULL DEFAULT 0;
  END IF;
END
$$;

-- 1c. rejection_reasons table
CREATE TABLE IF NOT EXISTS rejection_reasons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  label         text NOT NULL,
  sort_order    int  DEFAULT 0,
  is_default    bool DEFAULT false,
  created_at    timestamptz DEFAULT now()
);

-- 1d. stage_automations table
CREATE TABLE IF NOT EXISTS stage_automations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id),
  job_id         uuid REFERENCES jobs(id),
  stage_key      text NOT NULL,
  action_type    text NOT NULL
                   CHECK (action_type IN ('send_template_email','create_task','notify_recruiter')),
  action_payload jsonb DEFAULT '{}',
  created_at     timestamptz DEFAULT now()
);

-- ─────────────────────────────────────────────────
-- 2. Enable + Force RLS on all tenant-scoped tables
-- ─────────────────────────────────────────────────
ALTER TABLE workspaces         ENABLE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites            ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients            ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE resumes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities         ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_scores       ENABLE ROW LEVEL SECURITY;
ALTER TABLE fairness_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE rejection_reasons  ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_automations  ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspaces         FORCE ROW LEVEL SECURITY;
ALTER TABLE users              FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs         FORCE ROW LEVEL SECURITY;
ALTER TABLE invites            FORCE ROW LEVEL SECURITY;
ALTER TABLE clients            FORCE ROW LEVEL SECURITY;
ALTER TABLE jobs               FORCE ROW LEVEL SECURITY;
ALTER TABLE candidates         FORCE ROW LEVEL SECURITY;
ALTER TABLE applications       FORCE ROW LEVEL SECURITY;
ALTER TABLE resumes            FORCE ROW LEVEL SECURITY;
ALTER TABLE activities         FORCE ROW LEVEL SECURITY;
ALTER TABLE match_scores       FORCE ROW LEVEL SECURITY;
ALTER TABLE fairness_audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE rejection_reasons  FORCE ROW LEVEL SECURITY;
ALTER TABLE stage_automations  FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────
-- 3. Drop + recreate all workspace-isolation policies
-- ─────────────────────────────────────────────────
DROP POLICY IF EXISTS workspaces_workspace_isolation       ON workspaces;
DROP POLICY IF EXISTS users_workspace_isolation            ON users;
DROP POLICY IF EXISTS audit_logs_workspace_isolation       ON audit_logs;
DROP POLICY IF EXISTS invites_workspace_isolation          ON invites;
DROP POLICY IF EXISTS clients_workspace_isolation          ON clients;
DROP POLICY IF EXISTS jobs_workspace_isolation             ON jobs;
DROP POLICY IF EXISTS candidates_workspace_isolation       ON candidates;
DROP POLICY IF EXISTS applications_workspace_isolation     ON applications;
DROP POLICY IF EXISTS resumes_workspace_isolation          ON resumes;
DROP POLICY IF EXISTS activities_workspace_isolation       ON activities;
DROP POLICY IF EXISTS match_scores_workspace_isolation     ON match_scores;
DROP POLICY IF EXISTS fairness_audit_log_workspace_isolation ON fairness_audit_log;
DROP POLICY IF EXISTS rejection_reasons_workspace_isolation ON rejection_reasons;
DROP POLICY IF EXISTS stage_automations_workspace_isolation ON stage_automations;

CREATE POLICY workspaces_workspace_isolation ON workspaces
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY users_workspace_isolation ON users
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY audit_logs_workspace_isolation ON audit_logs
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY invites_workspace_isolation ON invites
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY clients_workspace_isolation ON clients
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY jobs_workspace_isolation ON jobs
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY candidates_workspace_isolation ON candidates
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY applications_workspace_isolation ON applications
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY resumes_workspace_isolation ON resumes
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY activities_workspace_isolation ON activities
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY match_scores_workspace_isolation ON match_scores
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY fairness_audit_log_workspace_isolation ON fairness_audit_log
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY rejection_reasons_workspace_isolation ON rejection_reasons
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY stage_automations_workspace_isolation ON stage_automations
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

-- ─────────────────────────────────────────────────
-- 4. Audit trigger functions (SECURITY DEFINER)
-- ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _audit_workspace_create()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO audit_logs (workspace_id, action, target_type, target_id)
  VALUES (NEW.id, 'workspace.create', 'workspace', NEW.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS workspace_audit_create ON workspaces;
CREATE TRIGGER workspace_audit_create
  AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION _audit_workspace_create();

CREATE OR REPLACE FUNCTION _audit_invite_create()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO audit_logs (workspace_id, action, target_type, target_id)
  VALUES (NEW.workspace_id, 'invite.create', 'invite', NEW.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS invite_audit_create ON invites;
CREATE TRIGGER invite_audit_create
  AFTER INSERT ON invites FOR EACH ROW EXECUTE FUNCTION _audit_invite_create();

CREATE OR REPLACE FUNCTION _audit_user_role_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.role IS DISTINCT FROM NEW.role THEN
    INSERT INTO audit_logs (workspace_id, action, target_type, target_id, diff_json)
    VALUES (NEW.workspace_id, 'member.role_change', 'user', NEW.id,
            jsonb_build_object('from', OLD.role, 'to', NEW.role));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS user_audit_role_change ON users;
CREATE TRIGGER user_audit_role_change
  AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION _audit_user_role_change();

CREATE OR REPLACE FUNCTION _audit_user_remove()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO audit_logs (workspace_id, action, target_type, target_id)
  VALUES (OLD.workspace_id, 'member.removed', 'user', OLD.id);
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS user_audit_remove ON users;
CREATE TRIGGER user_audit_remove
  AFTER DELETE ON users FOR EACH ROW EXECUTE FUNCTION _audit_user_remove();

-- ─────────────────────────────────────────────────
-- 5. NOTIFY trigger on applications
--    Fires on INSERT, UPDATE of (stage, position_in_stage), DELETE.
--    Payload JSON: {workspace_id, job_id, application_id, action}
--    SSE handler MUST verify workspace_id matches the authenticated user's
--    workspace before forwarding — cross-workspace leakage is a security bug.
-- ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _notify_application_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  payload jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    payload = jsonb_build_object(
      'workspace_id',    OLD.workspace_id,
      'job_id',          OLD.job_id,
      'application_id',  OLD.id,
      'action',          'DELETE'
    );
    PERFORM pg_notify('applications_changed', payload::text);
    RETURN OLD;
  ELSE
    payload = jsonb_build_object(
      'workspace_id',    NEW.workspace_id,
      'job_id',          NEW.job_id,
      'application_id',  NEW.id,
      'action',          TG_OP
    );
    PERFORM pg_notify('applications_changed', payload::text);
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS applications_notify        ON applications;
DROP TRIGGER IF EXISTS applications_notify_update ON applications;

CREATE TRIGGER applications_notify
  AFTER INSERT OR DELETE ON applications
  FOR EACH ROW EXECUTE FUNCTION _notify_application_change();

CREATE TRIGGER applications_notify_update
  AFTER UPDATE OF stage, position_in_stage ON applications
  FOR EACH ROW EXECUTE FUNCTION _notify_application_change();

-- ─────────────────────────────────────────────────
-- 6. Rejection-reasons seeding trigger
--    Seeds 7 defaults into rejection_reasons when a workspace is created.
-- ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _seed_rejection_reasons()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO rejection_reasons (workspace_id, label, sort_order, is_default) VALUES
    (NEW.id, 'Not enough experience', 0, true),
    (NEW.id, 'Skills mismatch',       1, true),
    (NEW.id, 'Salary expectations',   2, true),
    (NEW.id, 'Location/remote',       3, true),
    (NEW.id, 'Lost to other offer',   4, true),
    (NEW.id, 'Withdrew',              5, true),
    (NEW.id, 'Other',                 6, true);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS workspace_seed_rejection_reasons ON workspaces;
CREATE TRIGGER workspace_seed_rejection_reasons
  AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION _seed_rejection_reasons();

-- Back-fill rejection_reasons for existing workspaces that were created before this trigger
INSERT INTO rejection_reasons (workspace_id, label, sort_order, is_default)
SELECT w.id, v.label, v.sort_order, true
FROM workspaces w
CROSS JOIN (VALUES
  ('Not enough experience', 0),
  ('Skills mismatch',       1),
  ('Salary expectations',   2),
  ('Location/remote',       3),
  ('Lost to other offer',   4),
  ('Withdrew',              5),
  ('Other',                 6)
) AS v(label, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM rejection_reasons rr WHERE rr.workspace_id = w.id
);

-- ─────────────────────────────────────────────────
-- 7. pgvector + embedding columns + HNSW indexes
-- ─────────────────────────────────────────────────
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pgvector not available: %. Embedding columns skipped.', SQLERRM;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'candidates' AND column_name = 'embedding') THEN
      ALTER TABLE candidates ADD COLUMN embedding vector(1536);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'jobs' AND column_name = 'embedding') THEN
      ALTER TABLE jobs ADD COLUMN embedding vector(1536);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'candidates_embedding_hnsw_idx') THEN
      CREATE INDEX candidates_embedding_hnsw_idx ON candidates USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64) WHERE embedding IS NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'jobs_embedding_hnsw_idx') THEN
      CREATE INDEX jobs_embedding_hnsw_idx ON jobs USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64) WHERE embedding IS NOT NULL;
    END IF;
  ELSE
    RAISE NOTICE 'Skipping embedding columns — pgvector not installed.';
  END IF;
END
$$;
`;

async function main() {
  await client.connect();
  console.log("Applying RLS policies, triggers, and Batch 4 schema additions...");
  await client.query(SQL);
  console.log("Verifying...");

  const rls = await client.query(`
    SELECT relname, relrowsecurity
    FROM pg_class
    WHERE relname IN (
      'workspaces','users','audit_logs','invites',
      'clients','jobs','candidates','applications','resumes','activities',
      'match_scores','fairness_audit_log',
      'rejection_reasons','stage_automations'
    )
    ORDER BY relname
  `);
  console.log("RLS status:");
  rls.rows.forEach((r) => console.log(`  ${r.relname}: rowsecurity=${r.relrowsecurity}`));

  const tables = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('rejection_reasons','stage_automations')
    ORDER BY table_name
  `);
  console.log("Batch 4 tables:", tables.rows.map((r) => r.table_name).join(", "));

  const cols = await client.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_name IN ('jobs','applications')
      AND column_name IN ('stages_json','position_in_stage')
    ORDER BY table_name, column_name
  `);
  console.log("Batch 4 columns:", cols.rows.map((r) => `${r.table_name}.${r.column_name}`).join(", "));

  const triggers = await client.query(`
    SELECT trigger_name, event_object_table
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
      AND trigger_name IN ('applications_notify','applications_notify_update','workspace_seed_rejection_reasons')
    ORDER BY trigger_name
  `);
  console.log("Batch 4 triggers:", triggers.rows.map((r) => `${r.event_object_table}:${r.trigger_name}`).join(", "));

  const rrCount = await client.query(`SELECT COUNT(*) FROM rejection_reasons`);
  console.log(`rejection_reasons rows: ${rrCount.rows[0].count}`);

  await client.end();
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
