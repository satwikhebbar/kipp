-- OpenRouter chat-completion cost is persisted per generated plan version.
-- `legacy` keeps pre-migration rows on their existing model-pricing path;
-- `unavailable` marks a new request where OpenRouter returned no valid cost.
ALTER TABLE meal_plan_version ADD COLUMN usage_reported_cost_usd REAL;
ALTER TABLE meal_plan_version ADD COLUMN usage_reported_cost_status TEXT NOT NULL DEFAULT 'legacy'
  CHECK (usage_reported_cost_status IN ('legacy', 'reported', 'unavailable'));
