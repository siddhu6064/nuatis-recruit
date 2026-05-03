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
-- 1e. Batch 5 schema additions (idempotent)
-- ─────────────────────────────────────────────────

-- notes table
CREATE TABLE IF NOT EXISTS notes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id),
  candidate_id        uuid NOT NULL REFERENCES candidates(id),
  author_id           uuid NOT NULL REFERENCES users(id),
  body_html           text NOT NULL,
  body_plain          text NOT NULL,
  mentioned_user_ids  uuid[] DEFAULT '{}',
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

-- tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  candidate_id  uuid REFERENCES candidates(id),
  assignee_id   uuid NOT NULL REFERENCES users(id),
  created_by    uuid NOT NULL REFERENCES users(id),
  title         text NOT NULL,
  description   text,
  due_at        timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz DEFAULT now()
);

-- notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  recipient_id  uuid NOT NULL REFERENCES users(id),
  type          text NOT NULL,
  payload       jsonb DEFAULT '{}',
  read_at       timestamptz,
  created_at    timestamptz DEFAULT now()
);

-- saved_searches table
CREATE TABLE IF NOT EXISTS saved_searches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  owner_id      uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL,
  query_json    jsonb DEFAULT '{}',
  created_at    timestamptz DEFAULT now()
);

-- ─────────────────────────────────────────────────
-- 1g. Batch 6A: Communication Hub tables
-- ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_threads (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id),
  candidate_id     uuid        REFERENCES candidates(id),
  subject          text        NOT NULL,
  last_message_at  timestamptz,
  message_count    int         NOT NULL DEFAULT 0,
  nylas_thread_id  text,
  created_at       timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_messages (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id),
  thread_id         uuid        NOT NULL REFERENCES email_threads(id),
  nylas_message_id  text,
  direction         text        NOT NULL CHECK (direction IN ('outbound','inbound')),
  from_address      text        NOT NULL,
  to_addresses      text[]      NOT NULL DEFAULT '{}',
  cc_addresses      text[]      NOT NULL DEFAULT '{}',
  bcc_addresses     text[]      NOT NULL DEFAULT '{}',
  subject           text        NOT NULL,
  body_text         text        NOT NULL,
  body_html         text,
  message_id        text,
  in_reply_to       text,
  sent_at           timestamptz NOT NULL,
  status            text        NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sent','delivered','bounced','failed','received')),
  bounce_reason     text,
  created_at        timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connected_email_accounts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id),
  user_id         uuid        NOT NULL REFERENCES users(id),
  provider        text        NOT NULL CHECK (provider IN ('gmail','outlook','imap')),
  email_address   text        NOT NULL,
  nylas_grant_id  text        NOT NULL,
  connected_at    timestamptz NOT NULL DEFAULT now(),
  last_sync_at    timestamptz,
  status          text        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','revoked','error'))
);

-- ─────────────────────────────────────────────────
-- 1f. candidates.search_vector — regular tsvector column updated by trigger.
--     Using a trigger instead of GENERATED ALWAYS AS for compatibility.
--     The trigger fires on INSERT/UPDATE of the relevant columns.
-- ─────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidates' AND column_name = 'search_vector'
  ) THEN
    ALTER TABLE candidates ADD COLUMN search_vector tsvector;
  END IF;
END
$$;

-- Trigger function to recompute search_vector
CREATE OR REPLACE FUNCTION _candidates_search_vector_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.current_title, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.current_company, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.summary, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.emails, ' '), '')), 'D');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS candidates_search_vector_trig ON candidates;
CREATE TRIGGER candidates_search_vector_trig
  BEFORE INSERT OR UPDATE OF name, current_title, current_company, summary, emails
  ON candidates FOR EACH ROW EXECUTE FUNCTION _candidates_search_vector_update();

-- Back-fill existing rows (search_vector is NULL until first UPDATE)
UPDATE candidates SET name = name WHERE search_vector IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'candidates_search_vector_gin_idx'
  ) THEN
    CREATE INDEX candidates_search_vector_gin_idx ON candidates USING gin(search_vector);
  END IF;
END
$$;

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
ALTER TABLE notes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks              ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_searches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_threads            ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_email_accounts ENABLE ROW LEVEL SECURITY;

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
ALTER TABLE notes              FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks              FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications      FORCE ROW LEVEL SECURITY;
ALTER TABLE saved_searches     FORCE ROW LEVEL SECURITY;
ALTER TABLE email_threads            FORCE ROW LEVEL SECURITY;
ALTER TABLE email_messages           FORCE ROW LEVEL SECURITY;
ALTER TABLE connected_email_accounts FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────
-- 3. Drop + recreate all workspace-isolation policies
-- ─────────────────────────────────────────────────
DROP POLICY IF EXISTS workspaces_workspace_isolation         ON workspaces;
DROP POLICY IF EXISTS users_workspace_isolation              ON users;
DROP POLICY IF EXISTS audit_logs_workspace_isolation         ON audit_logs;
DROP POLICY IF EXISTS invites_workspace_isolation            ON invites;
DROP POLICY IF EXISTS clients_workspace_isolation            ON clients;
DROP POLICY IF EXISTS jobs_workspace_isolation               ON jobs;
DROP POLICY IF EXISTS candidates_workspace_isolation         ON candidates;
DROP POLICY IF EXISTS applications_workspace_isolation       ON applications;
DROP POLICY IF EXISTS resumes_workspace_isolation            ON resumes;
DROP POLICY IF EXISTS activities_workspace_isolation         ON activities;
DROP POLICY IF EXISTS match_scores_workspace_isolation       ON match_scores;
DROP POLICY IF EXISTS fairness_audit_log_workspace_isolation ON fairness_audit_log;
DROP POLICY IF EXISTS rejection_reasons_workspace_isolation  ON rejection_reasons;
DROP POLICY IF EXISTS stage_automations_workspace_isolation  ON stage_automations;
DROP POLICY IF EXISTS notes_workspace_isolation              ON notes;
DROP POLICY IF EXISTS tasks_workspace_isolation              ON tasks;
DROP POLICY IF EXISTS notifications_workspace_isolation      ON notifications;
DROP POLICY IF EXISTS notifications_insert                   ON notifications;
DROP POLICY IF EXISTS saved_searches_workspace_isolation     ON saved_searches;
DROP POLICY IF EXISTS email_threads_workspace_isolation            ON email_threads;
DROP POLICY IF EXISTS email_messages_workspace_isolation           ON email_messages;
DROP POLICY IF EXISTS connected_email_accounts_workspace_isolation ON connected_email_accounts;

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

CREATE POLICY notes_workspace_isolation ON notes
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY tasks_workspace_isolation ON tasks
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

-- Notifications: split policies so server-side INSERT (for any recipient in
-- the workspace) is not blocked by the recipient-scoped read policy.
-- INSERT: workspace isolation only — the API inserts on behalf of any recipient.
CREATE POLICY notifications_insert ON notifications
  FOR INSERT
  WITH CHECK (
    NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
    OR workspace_id::text = current_setting('app.current_workspace_id', true)
  );
-- SELECT/UPDATE/DELETE: workspace isolation + recipient scoping (own rows only).
CREATE POLICY notifications_workspace_isolation ON notifications
  FOR ALL
  USING (
    (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
     OR workspace_id::text = current_setting('app.current_workspace_id', true))
    AND
    (NULLIF(current_setting('app.current_user_id', true), '') IS NULL
     OR recipient_id::text = current_setting('app.current_user_id', true))
  );

CREATE POLICY saved_searches_workspace_isolation ON saved_searches
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

-- Batch 6A: Communication Hub policies (standard workspace isolation)
CREATE POLICY email_threads_workspace_isolation ON email_threads
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY email_messages_workspace_isolation ON email_messages
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY connected_email_accounts_workspace_isolation ON connected_email_accounts
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

-- Back-fill rejection_reasons for existing workspaces
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

-- Ensure nuatis_app has access to new tables (idempotent)
GRANT SELECT, INSERT, UPDATE, DELETE ON notes                     TO nuatis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tasks                     TO nuatis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications             TO nuatis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON saved_searches            TO nuatis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_threads             TO nuatis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_messages            TO nuatis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON connected_email_accounts  TO nuatis_app;

-- Batch 6A indexes (idempotent)
CREATE INDEX IF NOT EXISTS email_threads_workspace_candidate_idx
  ON email_threads (workspace_id, candidate_id);
CREATE INDEX IF NOT EXISTS email_threads_workspace_last_msg_idx
  ON email_threads (workspace_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS email_messages_workspace_thread_sent_idx
  ON email_messages (workspace_id, thread_id, sent_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS email_messages_nylas_message_id_uidx
  ON email_messages (nylas_message_id)
  WHERE nylas_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS email_threads_nylas_thread_id_uidx
  ON email_threads (nylas_thread_id)
  WHERE nylas_thread_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS connected_email_accounts_workspace_user_email_uidx
  ON connected_email_accounts (workspace_id, user_id, email_address);

-- ─────────────────────────────────────────────────
-- Batch 6A.5: email_templates table + RLS
-- ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_templates (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspaces(id),
  name         text        NOT NULL,
  subject      text        NOT NULL,
  body         text        NOT NULL,
  category     text        NOT NULL DEFAULT 'other'
               CHECK (category IN ('outreach','screening','interview','offer','rejection','follow_up','other')),
  is_archived  bool        NOT NULL DEFAULT false,
  created_by   uuid        NOT NULL REFERENCES users(id),
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_templates_workspace_archived_idx
  ON email_templates (workspace_id, is_archived);
CREATE INDEX IF NOT EXISTS email_templates_workspace_category_idx
  ON email_templates (workspace_id, category);

GRANT SELECT, INSERT, UPDATE, DELETE ON email_templates TO nuatis_app;

ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_templates_workspace_isolation ON email_templates;
CREATE POLICY email_templates_workspace_isolation ON email_templates
  USING (
    NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
    OR workspace_id::text = current_setting('app.current_workspace_id', true)
  );
`;

async function main() {
  await client.connect();
  console.log("Applying RLS policies, triggers, and Batch 5 schema additions...");
  await client.query(SQL);
  console.log("Verifying...");

  const rls = await client.query(`
    SELECT relname, relrowsecurity
    FROM pg_class
    WHERE relname IN (
      'workspaces','users','audit_logs','invites',
      'clients','jobs','candidates','applications','resumes','activities',
      'match_scores','fairness_audit_log',
      'rejection_reasons','stage_automations',
      'notes','tasks','notifications','saved_searches',
      'email_threads','email_messages','connected_email_accounts',
      'email_templates'
    )
    ORDER BY relname
  `);
  console.log("RLS status:");
  rls.rows.forEach((r) => console.log(`  ${r.relname}: rowsecurity=${r.relrowsecurity}`));

  const tables = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'notes','tasks','notifications','saved_searches',
        'email_threads','email_messages','connected_email_accounts',
        'email_templates'
      )
    ORDER BY table_name
  `);
  console.log("Batch 5+6A+6A.5 tables:", tables.rows.map((r) => r.table_name).join(", "));

  const cols = await client.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_name = 'candidates' AND column_name = 'search_vector'
  `);
  console.log("search_vector column:", cols.rows.length > 0 ? "present" : "MISSING");

  const idx = await client.query(`
    SELECT indexname FROM pg_indexes
    WHERE indexname = 'candidates_search_vector_gin_idx'
  `);
  console.log("GIN index:", idx.rows.length > 0 ? "present" : "MISSING");

  await client.end();
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
