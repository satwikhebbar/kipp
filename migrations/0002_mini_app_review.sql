-- Mini-App review and feedback durable contracts.
-- This migration is forward-only. Existing feedback rows describe revisions
-- that already consumed their feedback, so they receive the terminal state.

ALTER TABLE feedback_batch ADD COLUMN idempotency_key TEXT;
ALTER TABLE feedback_batch ADD COLUMN status TEXT NOT NULL DEFAULT 'consumed'
  CHECK (status IN ('accepted', 'delivered', 'processing', 'consumed', 'stale', 'failed'));
ALTER TABLE feedback_batch ADD COLUMN failure_category TEXT;
ALTER TABLE feedback_batch ADD COLUMN failure_notified_at TEXT;
ALTER TABLE feedback_batch ADD COLUMN updated_at TEXT;
UPDATE feedback_batch SET updated_at = created_at WHERE updated_at IS NULL;

-- Legacy batches have no idempotency key. The partial unique index leaves
-- those immutable historical records intact while enforcing Mini-App retries.
CREATE UNIQUE INDEX idx_feedback_batch_plan_idempotency
  ON feedback_batch(plan_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_feedback_batch_dispatch
  ON feedback_batch(status, created_at);

-- Mini App ownership belongs to the plan itself: the verified Telegram user
-- can open the plan sent to this private chat, but cannot choose a chat from
-- init data.
ALTER TABLE meal_plan ADD COLUMN telegram_user_id TEXT;
CREATE INDEX idx_meal_plan_telegram_user
  ON meal_plan(telegram_user_id, status, updated_at DESC);

-- Only a hash of the opaque browser bearer is durable. Sessions are short
-- lived and scoped to the review context selected after Telegram verification.
CREATE TABLE mini_app_session (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mini_app_session_expiry ON mini_app_session(expires_at);

-- Hashes of used initData values provide bounded replay protection without
-- retaining raw Telegram launch material.
CREATE TABLE mini_app_init_data_replay (
  fingerprint_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mini_app_init_data_replay_expiry ON mini_app_init_data_replay(expires_at);
