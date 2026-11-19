-- A plan keeps the schedule shape used by its initial generation for every
-- revision. Legacy rows are normalized and backfilled by the store before
-- they are returned to callers; null remains only during that transition.
ALTER TABLE meal_plan ADD COLUMN schedule_json TEXT;
ALTER TABLE meal_plan ADD COLUMN established_meal_definitions_json TEXT;
