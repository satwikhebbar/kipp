-- Meal-planning durable contracts (iteration-1 plan §4).
-- One database MEAL_PLANNING_DB. All timestamps are ISO-8601 UTC at fixed
-- precision (created_at, updated_at, week_start, week_end); week_end > ?
-- comparisons are lexical, so writers must emit the identical format.
-- No transcripts or raw provider text are stored (privacy rule).

-- Household profile (single-bot: one row per Telegram chat)
CREATE TABLE meal_profile (
  chat_id TEXT PRIMARY KEY,
  profile_json TEXT NOT NULL,            -- MealProfile
  custom_policies_json TEXT NOT NULL,    -- CustomPolicy[]
  schedule_json TEXT NOT NULL,           -- MealSchedule
  location_json TEXT,                    -- { country, city } | NULL
  interaction_generation INTEGER NOT NULL DEFAULT 0, -- chat-scoped plan-message generation (§6)
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Plan header: one active plan per chat (previous active -> 'replaced')
CREATE TABLE meal_plan (
  plan_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  timezone TEXT NOT NULL,
  instance_id TEXT NOT NULL,             -- live Workflow instance id (the webhook's fallthrough pointer, §6)
  status TEXT NOT NULL DEFAULT 'active', -- active | replaced
  current_version INTEGER NOT NULL DEFAULT 0,
  weekly_inventory_json TEXT NOT NULL DEFAULT '{}', -- week-scoped state
  weekly_exceptions_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_meal_plan_chat ON meal_plan(chat_id, status);

-- Exactly one active plan per chat, enforced by the database. A concurrent
-- second active INSERT fails atomically (whole batch rolls back).
CREATE UNIQUE INDEX idx_meal_plan_one_active ON meal_plan(chat_id) WHERE status = 'active';

-- Immutable plan versions. No UPDATE statements ever target this table.
CREATE TABLE meal_plan_version (
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  candidate_json TEXT NOT NULL,          -- grid + easyBuys + policyOutcomes
  evaluation_json TEXT NOT NULL,         -- failures + measurements
  request_kind TEXT NOT NULL,            -- initial_plan | revision
  base_version INTEGER,                  -- NULL for initial
  feedback_batch_id TEXT,                -- batch that drove this version (NULL only for the initial plan)
  video_json TEXT NOT NULL DEFAULT '{}', -- per-cell video results (lunch slots)
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, version)
);

-- Feedback submission record: one immutable batch per feedback-driven
-- revision, created atomically with the version it drove (promotePlanVersion).
-- No lifecycle (no status transitions), no accumulation -- a submission is
-- consumed by the revision it triggers. The initial plan has no batch.
CREATE TABLE feedback_batch (
  batch_id TEXT PRIMARY KEY,             -- plan_id || ':v' || newVersion
  plan_id TEXT NOT NULL,
  base_version INTEGER NOT NULL,         -- the version the feedback targeted
  items_json TEXT NOT NULL,              -- FeedbackItem[] as submitted
  created_at TEXT NOT NULL
);
