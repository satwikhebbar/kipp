-- Older versions have no historical schedule snapshot.
ALTER TABLE meal_plan_version ADD COLUMN recurring_half_days_json TEXT;
