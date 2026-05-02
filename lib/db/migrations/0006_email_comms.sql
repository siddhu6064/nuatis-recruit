-- Migration: Batch 6A — Communication Hub schema
-- Tables: email_threads, email_messages, connected_email_accounts
-- Idempotent — safe to re-run (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
-- Applied automatically by lib/db/scripts/apply-rls.ts (migrate:rls).

-- ── email_threads ────────────────────────────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS email_threads_workspace_candidate_idx
  ON email_threads (workspace_id, candidate_id);

CREATE INDEX IF NOT EXISTS email_threads_workspace_last_msg_idx
  ON email_threads (workspace_id, last_message_at DESC);

-- ── email_messages ───────────────────────────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS email_messages_workspace_thread_sent_idx
  ON email_messages (workspace_id, thread_id, sent_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS email_messages_nylas_message_id_uidx
  ON email_messages (nylas_message_id)
  WHERE nylas_message_id IS NOT NULL;

-- ── connected_email_accounts ─────────────────────────────────────────────────

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

CREATE UNIQUE INDEX IF NOT EXISTS connected_email_accounts_workspace_user_email_uidx
  ON connected_email_accounts (workspace_id, user_id, email_address);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE email_threads            ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_threads            FORCE ROW LEVEL SECURITY;
ALTER TABLE email_messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages           FORCE ROW LEVEL SECURITY;
ALTER TABLE connected_email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_email_accounts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_threads_workspace_isolation            ON email_threads;
DROP POLICY IF EXISTS email_messages_workspace_isolation           ON email_messages;
DROP POLICY IF EXISTS connected_email_accounts_workspace_isolation ON connected_email_accounts;

CREATE POLICY email_threads_workspace_isolation ON email_threads
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY email_messages_workspace_isolation ON email_messages
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

CREATE POLICY connected_email_accounts_workspace_isolation ON connected_email_accounts
  USING (NULLIF(current_setting('app.current_workspace_id', true), '') IS NULL
         OR workspace_id::text = current_setting('app.current_workspace_id', true));

-- ── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON email_threads            TO nuatis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_messages           TO nuatis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON connected_email_accounts TO nuatis_app;

-- ── Audit action keys reserved for Batch 6A.1 ────────────────────────────────
-- email.sent, email.received, email.bounced, email_account.connected, email_account.revoked
-- No writes here — keys are allowlisted at the application layer.
