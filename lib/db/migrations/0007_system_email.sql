-- Migration 0007: System transactional email support
-- 1. Add postmark_message_id column to email_messages (Postmark GUID from send response)
-- 2. Make thread_id nullable — system emails (workspace user notifications) don't belong to a thread

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS postmark_message_id TEXT,
  ALTER COLUMN thread_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS email_messages_postmark_msg_id_idx
  ON email_messages (postmark_message_id)
  WHERE postmark_message_id IS NOT NULL;
