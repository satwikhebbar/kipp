# Issue #70 — Per-user meal profile and schedule editing

> **Status:** Initial implementation plan for review  
> **Issue:** [#70 Per-user meal profile and schedule editing](https://github.com/satwikhebbar/kipp/issues/70)  
> **Plan boundary:** Configuration edits affect future planning context. They do not silently rewrite an existing plan or its immutable versions.

## 1. Goal

Let the authenticated meal-planning user maintain their own household profile and recurring weekly meal schedule, so Kipp can plan a household's actual days and meal slots instead of assuming the starter Monday–Saturday school-week template.

The user should be able to inspect and edit the durable profile in the existing Telegram Mini App. Schedule configuration should support any selected days of the week and a user-defined set/order of meal slots, including no school snacks, one snack, multiple snacks, or a household without school days. The current seed remains the first-use default for compatibility.

## 2. Current state and constraints

- `meal_profile` is keyed by `chat_id` and stores `profile_json`, `custom_policies_json`, `schedule_json`, and `location_json`; the store has D1 and in-memory implementations.
- The seed schedule in `src/meal-planning/store.ts` is Mon–Sat with five slots (breakfast, two school snacks, school lunch, home lunch), plus Saturday as a recurring half day.
- The Mini App authenticates Telegram `initData`, checks `TELEGRAM_ALLOWED_USER_ID`, and currently presents a read/review and feedback surface, not profile configuration.
- `MealSchedule` and `MealProfile` are already the planner's typed context. The schedule evaluator is mostly data-driven, but editor validation, profile mutation APIs, and comprehensive schedule variants are not present.
- Plan versions are immutable, but the Mini App currently renders them against the current profile schedule. A profile schedule edit must not cause historical plan grids to be reinterpreted or disappear.
- The deployment currently has a single-user allowlist. “Per-user” is interpreted for this plan as ownership-isolated state for the authenticated Telegram account, without enabling public/multi-user access or changing Telegram admission policy.

## 3. Product behavior

### Profile editor

- Add a clearly reachable **Household settings** view in the authenticated Mini App, available whether or not a current plan exists.
- Edit the existing durable fields: dietary exclusions; favourite and avoided foods; allow-new-foods; sensory guidelines; morning cooking budget; prior-night preparation permission; pantry baseline; custom policies; and location. Keep meal definitions/repertoire management bounded to what existing supported controls can safely express; do not add a free-form recipe editor in this issue unless the reviewer confirms it is required.
- Load and save as a complete versioned configuration with server-side validation. Preserve values the editor does not expose; never replace unsupported fields with defaults on save.
- Show a saved/failed state. A conflict response should reload the latest configuration and let the user reapply changes, rather than silently overwriting a concurrent edit.

### Schedule editor

- Select one or more weekdays in Monday-to-Sunday order, then configure an ordered list of meal slots. A slot has a stable ID, display name, packed/dry flags, and optional maximum cooking minutes, matching `MealSlot`.
- Add, rename, reorder, and remove slots. Enforce unique stable slot IDs, unique days, non-empty labels, valid cooking limits, and at least one day and one slot. Day selection must allow Sunday and must not assume Saturday is special.
- Retain `halfDays` as the recurring half-day rule, constrained to selected days. Provide an explicit way to clear it. Weekly one-off school closures, half days, and other exceptions remain week-scoped planning context and are not part of the recurring schedule editor.
- The initial schedule remains the current starter template. A saved schedule applies to the next plan creation/replan. Existing active and historical plan versions retain the exact schedule they were planned against; editing settings does not trigger replanning.

## 4. Design

### Identity and persistence

For this iteration, retain the current Telegram authorization boundary and `chat_id`-owned row model. All reads and writes derive the owner from the verified Mini App session; the client must not submit an owner identifier. Do not add a new binding or environment variable.

Add an optimistic configuration version to `meal_profile` (or use the existing `version` column if its current semantics are verified to be suitable). A store operation accepts an expected version and a validated full configuration, updates profile, policies, schedule, and location atomically, increments the version, and returns either the saved row or a stale-version conflict. Implement identical semantics in D1 and in-memory stores. Keep legacy schedule upgrades idempotent and preserve old rows through an additive migration if needed.

Add an immutable schedule snapshot to each plan at plan creation (preferably a `schedule_json` column on `meal_plan`, since the schedule is shared across all versions of a plan). Read paths for current and historical plans use the plan snapshot. Existing rows with a null/missing snapshot fall back to the legacy profile schedule for compatibility; backfill is optional only if the migration can safely capture the current schedule without changing behavior.

### Validation and planner compatibility

- Define one strict schedule schema and deterministic semantic validator shared by Mini App request validation, store validation, tests, and corpus inputs. Enforce canonical weekdays and uniqueness; enforce slot ID uniqueness and reasonable bounds (bounded list/string lengths and non-negative integer cooking limits).
- Treat meal slot IDs as stable opaque keys; slot labels are display-only. Renaming a slot must preserve its ID so persisted grid cells remain associated. Removing a day/slot changes future planner shape only.
- Validate profile field lengths/counts and string normalization at the API boundary; retain hard dietary exclusions as explicit text without model rewriting.
- Audit hard-coded six-day/five-slot assumptions in evaluator, prompt/tool schemas, corpus schemas, plan rendering, Mini App display, and feedback target validation. Replace only assumptions incompatible with configurable schedules; retain school-specific safety policy where it is explicitly part of the product contract.
- Continue rejecting candidates with missing/extra schedule cells through deterministic evaluation. No LLM-controlled schedule or profile mutation is introduced.

### Mini App API and UI

- Add authenticated `GET /mini-app/api/profile` and `PUT /mini-app/api/profile` endpoints (or an equivalent resource route consistent with existing conventions). Use bounded JSON bodies, `no-store` responses, strict schemas, session-derived ownership, and stable generic error responses.
- Add a settings route/view without disturbing plan review, history, or feedback flow. The client should use existing session token handling and should not persist profile contents in local/device storage.
- On profile save, return the canonical server state and new version. On version conflict, return a typed conflict that the UI handles with a reload/reapply path.

## 5. Delivery iterations

### Iteration 1 — Stable configurable schedule contract

- Add strict schedule/profile schemas and semantic validation; include all seven weekdays, variable slot counts, empty school-week days, and half-day subset behavior.
- Add plan schedule snapshots and compatible store contracts/migration in D1 and in-memory implementations.
- Audit planner/evaluator/rendering assumptions and update fixtures/corpus for representative schedules.
- Tests cover legacy hydration, version snapshots, schedule validation, candidate shape, historical plan rendering, and unchanged seed behavior.

### Iteration 2 — Authenticated profile persistence API

- Add atomic optimistic profile/configuration update to the store, including D1/in-memory parity and version conflict handling.
- Add authenticated Mini App profile read/write routes with strict request bounds, session-derived owner, and no-store headers.
- Tests cover authorization/owner isolation, malformed and oversized payloads, stale version conflict, atomicity, and data preservation for unexposed fields.

### Iteration 3 — Profile and schedule editing experience

- Add the Mini App settings navigation and forms for the supported profile fields and configurable day/slot schedule.
- Add save, loading, validation, conflict, and error states; preserve existing plan/review behavior and local feedback drafts.
- Add route/UI behavior tests or the project's closest automated coverage for schedule variations and profile save/reload; update the relevant product documentation and local acceptance steps.

## 6. Acceptance criteria

1. A user can edit and reload their profile and recurring schedule through the authenticated Mini App, including a chosen set of weekdays and a custom ordered slot list.
2. The initial seeded user sees the existing starter profile/schedule until they save a change.
3. Future plans are evaluated and rendered using the saved schedule; varied day counts and slot counts are accepted only when the candidate covers exactly that schedule.
4. Existing active and historical plans continue to render with their original schedule after profile edits.
5. Profile state is isolated by authenticated owner; the client cannot read or mutate another owner's profile by changing request data.
6. Concurrent saves do not silently overwrite each other, and invalid schedules/profile payloads are rejected before persistence.
7. There are no changes to production bindings, secrets, scheduled jobs, or Telegram allowlist policy in this iteration.

## 7. Validation and rollout

- Run focused store/schema/evaluator/Mini App route tests, then the repository's documented full quality gate (`pnpm check`) after implementation.
- Exercise first-use seed behavior, a no-snack two-day schedule, a one-snack weekday schedule, Sunday inclusion, slot add/rename/reorder/remove, half-day toggling, stale save conflict, and historical plan review after a schedule change.
- No new production configuration is expected. If implementation reveals a required Worker binding, `Env` variable, workflow, cron, or Durable Object change, stop and consult `docs/production-runtime-configuration.md` before changing it.

## 8. Review decision to resolve

The issue title says “per-user,” while today's runtime deliberately admits only `TELEGRAM_ALLOWED_USER_ID`. This plan preserves that admission boundary and scopes per-user isolation to the authenticated account's data model. If #70 intends multiple independently admitted Telegram accounts in one deployment, that requires an explicit identity/admission design (configuration shape, existing data migration from `chat_id`, and account onboarding) and should be added to scope before approval.

