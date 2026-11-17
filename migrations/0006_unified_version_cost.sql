-- One cost for each version, including the easy-buy classifier. Preserve the
-- historical classifier component for legacy rows without estimating/backfilling
-- their planner charge; the legacy report path still prices their stored tokens.
ALTER TABLE meal_plan_version ADD COLUMN cost_usd REAL CHECK (cost_usd >= 0);
ALTER TABLE meal_plan_version ADD COLUMN cost_status TEXT NOT NULL DEFAULT 'legacy'
  CHECK (cost_status IN ('legacy', 'reported', 'unavailable'));

UPDATE meal_plan_version
SET cost_status = usage_reported_cost_status,
    cost_usd = CASE usage_reported_cost_status
      WHEN 'reported' THEN usage_reported_cost_usd + COALESCE(decisions_cost_usd, 0)
      WHEN 'unavailable' THEN NULL
      ELSE decisions_cost_usd
    END;

ALTER TABLE meal_plan_version DROP COLUMN decisions_cost_usd;
ALTER TABLE meal_plan_version DROP COLUMN usage_reported_cost_usd;
ALTER TABLE meal_plan_version DROP COLUMN usage_reported_cost_status;
