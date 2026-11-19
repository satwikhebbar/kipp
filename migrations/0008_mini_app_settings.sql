-- Settings-only Mini App launches are private-chat scoped, short-lived and
-- single-use. Only the opaque reference hash is stored.
CREATE TABLE mini_app_settings_launch (
  token_hash TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mini_app_settings_launch_expiry ON mini_app_settings_launch(expires_at);

-- Review sessions remain plan-scoped. Settings sessions have no plan scope.
ALTER TABLE mini_app_session RENAME TO mini_app_session_legacy;
CREATE TABLE mini_app_session (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  plan_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('review', 'settings')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((scope = 'review' AND plan_id IS NOT NULL) OR (scope = 'settings' AND plan_id IS NULL))
);
INSERT INTO mini_app_session (session_id, token_hash, telegram_user_id, chat_id, plan_id, scope, expires_at, created_at)
SELECT session_id, token_hash, telegram_user_id, chat_id, plan_id, 'review', expires_at, created_at
FROM mini_app_session_legacy;
DROP TABLE mini_app_session_legacy;
CREATE INDEX idx_mini_app_session_expiry ON mini_app_session(expires_at);
