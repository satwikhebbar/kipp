-- Generation leases keep the currently persisted plan visible while a new
-- plan is being generated. The lease is chat-scoped and expires as a crash
-- recovery backstop; it never replaces or mutates a meal_plan row.
CREATE TABLE meal_plan_generation (
  chat_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generating', 'failed')),
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_meal_plan_generation_expiry
  ON meal_plan_generation(status, expires_at);
