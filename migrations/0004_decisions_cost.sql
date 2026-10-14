-- Reported USD cost of the easy-buy classifier's Decisions calls for this
-- version. Forward-only and insert-only, like the token columns in 0003.
-- The Decisions endpoint returns cost directly; the planner and the other
-- providers return only token counts, so their cost stays derived at report
-- time from src/core/cost.ts. NULL = no classifier run for this version.
ALTER TABLE meal_plan_version ADD COLUMN decisions_cost_usd REAL;
