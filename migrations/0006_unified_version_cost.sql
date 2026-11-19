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

-- Expand-only rollout: the previous Worker and in-flight workflows may still
-- write the old columns after migrations run and before the upload completes.
-- Keep those writes reflected in the authoritative cost during the overlap.
CREATE TRIGGER meal_plan_version_legacy_cost_insert
AFTER INSERT ON meal_plan_version
WHEN NEW.cost_status = 'legacy' AND
  (NEW.decisions_cost_usd IS NOT NULL OR NEW.usage_reported_cost_status <> 'legacy')
BEGIN
  UPDATE meal_plan_version
  SET cost_status = NEW.usage_reported_cost_status,
      cost_usd = CASE NEW.usage_reported_cost_status
        WHEN 'reported' THEN NEW.usage_reported_cost_usd + COALESCE(NEW.decisions_cost_usd, 0)
        WHEN 'unavailable' THEN NULL
        ELSE NEW.decisions_cost_usd
      END
  WHERE plan_id = NEW.plan_id AND version = NEW.version;
END;

CREATE TRIGGER meal_plan_version_legacy_cost_update
AFTER UPDATE OF decisions_cost_usd, usage_reported_cost_usd, usage_reported_cost_status ON meal_plan_version
BEGIN
  UPDATE meal_plan_version
  SET cost_status = NEW.usage_reported_cost_status,
      cost_usd = CASE NEW.usage_reported_cost_status
        WHEN 'reported' THEN NEW.usage_reported_cost_usd + COALESCE(NEW.decisions_cost_usd, 0)
        WHEN 'unavailable' THEN NULL
        ELSE NEW.decisions_cost_usd
      END
  WHERE plan_id = NEW.plan_id AND version = NEW.version;
END;

-- Drop the compatibility triggers and old columns only in a later release,
-- after the prior Worker and every workflow using it have drained. Do not ship
-- that contraction migration in this release: deploy applies all pending SQL.
