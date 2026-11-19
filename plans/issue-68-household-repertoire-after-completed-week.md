# Issue #68 — Add newly tried dishes to the household repertoire after an approved, completed week

## Goal

When a household has approved and completed a meal-planning week, add eligible newly tried dishes from that week to the durable household meal repertoire. Subsequent weekly plans should be able to select those dishes as established meals, with their validated meal definitions and existing household constraints intact.

The plan treats “approved, completed week” as a required gate: an unapproved, incomplete, superseded, or merely generated week must not change the household repertoire. The exact user-facing approval/completion signal and whether dishes are added automatically or individually confirmed must follow the issue’s acceptance criteria when available; the issue page and local Beads record were inaccessible during planning.

## Current architecture and constraints

- `MealProfile` in `src/meal-planning/types.ts` owns the persistent `mealDefinitions` catalog. Definitions have `established` and `provisional` statuses; the legacy `dishRepertoire` string array is deprecated.
- New definitions are hydrated as plan-local provisional definitions (`src/meal-planning/hydration.ts`). They are stored with immutable `meal_plan_version` snapshots and can be inherited by revisions of that plan. They should not silently become household-owned just because a plan was generated or revised.
- `meal_profile.profile_json` is the D1 persistence boundary for household definitions. `createMealPlanningStore` has both D1 and in-memory implementations; any new state transition must preserve parity and existing serialized profile shape.
- A household definition should use the existing server-side validation/establishment rules in `src/meal-planning/catalog.ts`. Keep model-authored definitions validated; the completion path must not accept client-authored definition fields or bypass dietary/schedule validation.
- Workflow operations are durable and can replay. The transition must be idempotent, scoped to the correct chat and exact plan/week, and safe if the completion signal is delivered more than once. Existing plan/version immutability, feedback CAS, and active-plan generation behavior must remain unchanged.
- No new Worker binding, `Env` setting, workflow, cron, or Durable Object is presumed by this design. Revisit `docs/production-runtime-configuration.md`, `config/runtime-variables.json`, and provisioning requirements if implementation changes that scope.

## Proposed design

1. Trace the existing end-of-week and approval interaction paths before choosing the trigger. Reuse an existing authenticated parent action and persisted plan identity if one exists; do not infer completion from wall-clock week-end alone. If no durable approval/completion signal currently exists, add the smallest explicit server-owned state transition needed to represent it.
2. On that authorized transition, read the exact plan/version and its plan-local provisional meal definitions. Filter to dishes that were actually tried during that week according to the established completion signal. Do not promote every generated proposal automatically when it was not cooked/tried.
3. Convert only eligible definitions using existing validation and establishment semantics. Merge into `profile.mealDefinitions` while retaining existing definitions and profile preferences. Deduplicate by stable ID and normalized name/aliases so retries or equivalent names cannot create duplicate catalog entries. Do not mutate the immutable plan-version snapshot.
4. Persist the profile merge and completion marker atomically (or use an equivalent compare-and-set/idempotency guard) so a retry cannot lose concurrent profile updates or promote the same week twice. Keep the operation scoped by chat ID and plan ID, and reject stale, replaced, or mismatched plan actions.
5. Return a narrow result suitable for the existing workflow response: newly added dish names and any skipped/duplicate dishes as appropriate. Avoid exposing internal definition payloads or adding a separate catalog-management interface unless required by issue acceptance criteria.

## Implementation areas to inspect/change

- `src/meal-planning/agent-workflow.ts` and the workflow entry/interaction routing: locate the actual week approval/completion signal and ensure only the authorized path invokes promotion.
- `src/meal-planning/store.ts`: add a typed store operation for atomic, idempotent promotion; implement it in both D1 and in-memory stores. Add a migration only if a durable completion/idempotency record cannot fit safely in current state.
- `src/meal-planning/types.ts` and `src/meal-planning/catalog.ts`: reuse or extend the validated established-definition conversion without weakening current constraints.
- Existing workflow/store tests and migration tests: cover correct gating, retry behavior, and new-plan visibility.

## Acceptance criteria for implementation

- Newly tried provisional dishes become established household definitions only after the exact week has both the required approval and completion evidence.
- Generated-but-not-tried dishes, unapproved weeks, incomplete weeks, replaced plans, and stale/mismatched actions do not alter the repertoire.
- Re-delivery/replay of the same completion action is safe and does not duplicate definitions or lose profile data.
- Existing established meals, household preferences, policies, and definition validity are preserved.
- Newly promoted definitions are available to later plans and remain separate from old immutable version snapshots.
- D1 and in-memory store behavior agree; tests cover positive, negative, duplicate/replay, and stale-plan cases.

## Validation

Run focused meal-planning store/workflow tests and migration tests for the changed paths, then the repository quality gates (`pnpm check` and relevant integration tests) as directed for implementation. Planning only: no implementation or validation commands that mutate runtime configuration are in scope here.

## Open point for plan review

The issue body could not be retrieved from GitHub (`gh` reported an API connectivity failure; browser fetch returned a cache miss), and `bd show bd-68` could not open the local Dolt database due to a lock permission error. The plan therefore uses the title’s approval/completion gate and current architecture as its basis. Reviewer/coordinator should compare the issue’s exact acceptance wording—especially whether parents mark individual dishes tried or approve the whole week—before implementation begins.
