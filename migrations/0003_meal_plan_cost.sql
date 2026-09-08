-- Per-version LLM token usage for meal-plan cost reporting (issue #72).
-- This migration is forward-only. meal_plan_version is insert-only; the three
-- columns are written once with the version row and never updated.
-- NULL = a version persisted before cost tracking (no usage was recorded for
-- that version). Usage is priced at report time from src/core/cost.ts, so
-- historical cost lines reflect the current pricing table.

ALTER TABLE meal_plan_version ADD COLUMN usage_input_tokens INTEGER;
ALTER TABLE meal_plan_version ADD COLUMN usage_output_tokens INTEGER;
ALTER TABLE meal_plan_version ADD COLUMN usage_model TEXT;
