-- Freeze the plan/version evidence needed by week-end repertoire processing.
ALTER TABLE meal_plan ADD COLUMN replaced_at TEXT;
ALTER TABLE meal_plan ADD COLUMN approved_version INTEGER;
ALTER TABLE meal_plan ADD COLUMN rejected_version INTEGER;
ALTER TABLE meal_plan ADD COLUMN rejected_meal_ids_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE meal_plan_version ADD COLUMN allow_new_foods_snapshot INTEGER
  CHECK (allow_new_foods_snapshot IS NULL OR allow_new_foods_snapshot IN (0, 1));
