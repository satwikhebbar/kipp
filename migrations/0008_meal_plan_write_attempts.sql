-- Identify the row inserted by this batch, even if an older attempt used the same plan/version key.
ALTER TABLE meal_plan ADD COLUMN write_attempt_id TEXT;
ALTER TABLE meal_plan_version ADD COLUMN write_attempt_id TEXT;
