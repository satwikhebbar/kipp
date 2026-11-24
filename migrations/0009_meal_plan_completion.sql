CREATE TABLE meal_plan_completion (
  plan_id TEXT PRIMARY KEY REFERENCES meal_plan(plan_id),
  version INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  added_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  invalid_count INTEGER NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE TABLE meal_plan_completion_cursor (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  week_end TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  revision TEXT NOT NULL
);

CREATE INDEX idx_meal_plan_week_end ON meal_plan(week_end, plan_id);
CREATE INDEX idx_meal_plan_chat_week_created ON meal_plan(chat_id, week_start, created_at);
