# Issue #70 — Per-user meal profile and schedule editing

> **Status:** Revised implementation plan for review
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
- Current planning weeks are Monday through Saturday, with Sunday treated as the following week's invocation day. The persisted `week_end` also controls edit expiry. Half-day evaluation currently relies on the seed IDs `snack1`, `snack2`, and `school-lunch`.
- The deployment currently has a single-user allowlist. “Per-user” is interpreted for this plan as ownership-isolated state for the authenticated Telegram account, without enabling public/multi-user access or changing Telegram admission policy.

## 3. Product behavior

### Profile editor

- Add a clearly reachable **Household settings** view in the authenticated Mini App, available whether or not a current plan exists. In Telegram private chat, an admitted user can send `/mealsettings`; the bot returns a Mini App launch button. The button is usable before any plan exists.
- Edit the existing durable fields: dietary exclusions; favourite and avoided foods; allow-new-foods; sensory guidelines; morning cooking budget; prior-night preparation permission; pantry baseline; custom policies; and location. Keep meal definitions/repertoire management bounded to what existing supported controls can safely express; do not add a free-form recipe editor in this issue unless the reviewer confirms it is required.
- Load and save as a complete versioned configuration with server-side validation. Preserve values the editor does not expose; never replace unsupported fields with defaults on save.
- Show a saved/failed state. A conflict response should reload the latest configuration and let the user reapply changes, rather than silently overwriting a concurrent edit.

### Schedule editor

- Select one or more weekdays in Monday-to-Sunday order, then configure an ordered list of meal slots. A slot has a stable ID, display name, packed/dry flags, and optional maximum cooking minutes, matching `MealSlot`.
- Add, rename, reorder, and remove slots. Enforce unique stable slot IDs, unique days, non-empty labels, valid cooking limits, and at least one day and one slot. Day selection must allow Sunday and must not assume Saturday is special.
- Retain `halfDays` as the recurring half-day rule, constrained to selected days. Provide an explicit way to clear it. Weekly one-off school closures, half days, and other exceptions remain week-scoped planning context and are not part of the recurring schedule editor.
- Define half-day behavior per configured slot, with `keep`, `omit`, or `quick` behavior; quick slots have a bounded cooking-time cap. The seed mapping preserves today's exact behavior: `snack1` is quick with a 20-minute cap, `snack2` and `school-lunch` are omitted, and all other slots remain. Custom schedules use their saved per-slot behavior and are never interpreted through those seed IDs. A half day must retain at least one meal slot.
- The initial schedule remains the current starter template. A saved schedule is adopted only by an explicit new `/mealplan` request, which creates a new plan and replaces the former active plan. Feedback and context revisions of an existing plan continue on that plan's pinned schedule, even after the profile schedule changes. Settings edits never trigger a plan mutation.

### Planning week behavior

- Keep Monday as the week start. Preserve current seed behavior and expiry by ending schedules without Sunday at Saturday 23:59:59 local. When the saved schedule includes Sunday, extend that plan's `week_end` to Sunday 23:59:59 local; the plan's captured schedule determines the bound for its entire lifetime.
- Preserve the default invocation rule: Monday–Wednesday target the current Monday week; Thursday–Sunday target the next Monday week. A custom Sunday schedule is part of the Monday-starting week; `this week` or a valid date override can target the current Sunday while its schedule-derived `week_end` remains open. Preserve existing meanings of `next week` and stale-week clamping.
- Plan edit/feedback deadlines remain the persisted `week_end`; a plan whose pinned schedule includes Sunday remains editable through Sunday 23:59:59 local. Week resolution, expiry, and rendering must use the captured schedule rather than a hard-coded Saturday boundary. Prior-week variety still selects the immediately preceding Monday-starting period.

## 4. Design

### Identity and persistence

For this iteration, retain the current Telegram authorization boundary and `chat_id`-owned row model. All reads and writes derive the owner from the verified Mini App session; the client must not submit an owner identifier. Do not add a new binding or environment variable.

Use the existing `meal_profile.version` only after confirming its current semantics; otherwise add a dedicated configuration version. A store operation accepts an expected version and a validated full configuration, updates profile, policies, schedule, and location atomically, increments the version, and returns either the saved row or a stale-version conflict. Implement identical semantics in D1 and in-memory stores.

Add an immutable schedule snapshot to each plan. New plan generation captures the canonical profile and schedule before planning starts and passes that captured schedule (and config version) through `createActivePlan`; persistence must store the same snapshot used to evaluate the candidate, even if settings are saved while generation is in flight. Do not reload the mutable profile schedule during persistence.

Before profile updates are enabled, freeze every existing plan's schedule. Add nullable schedule snapshot columns and perform a mandatory legacy backfill before exposing the write path. For each plan, capture the schedule as currently interpreted by the corresponding existing read path, including `upgradeLegacyMealSchedule` normalization. Snapshot the active plan and every retained historical plan. If a row cannot be backfilled, reject profile updates with a generic unavailable/conflict response until it can be safely frozen; never use the newly edited profile schedule as a fallback for a legacy plan. The backfill is idempotent and occurs before any successful profile save.

Pin the plan schedule for every plan version. Ordinary feedback/context revisions remain within that plan and use its schedule snapshot. They do not adopt profile edits. Explicit adoption of changed settings requires a new plan request, which snapshots the current configuration and creates a new plan. This avoids mixing incompatible grid shapes in one plan's version history.

Legacy hydration must participate in the same configuration concurrency contract. Replace the current unguarded profile/schedule JSON writes from `loadOrCreateProfile` with one atomic compare-and-set update guarded by the version read, incrementing the configuration version when normalization changes persisted data. On CAS loss, reread and return the winner's state; never retry the stale hydrated values over the winning save. Profile updates first complete hydration or receive the latest canonical version, then perform their own expected-version CAS. Apply the same interleaving semantics in-memory. Prefer a migration/backfill for transformations that can be done safely in SQL; any application-level transformation still uses this guarded strategy.

### Validation and planner compatibility

- Define one strict schedule schema and deterministic semantic validator shared by Mini App request validation, store validation, tests, and corpus inputs. Enforce canonical weekdays and uniqueness; enforce slot ID uniqueness and reasonable bounds (bounded list/string lengths and non-negative integer cooking limits), and validate the per-slot half-day behavior/cap.
- Treat meal slot IDs as stable opaque keys; slot labels are display-only. Renaming a slot must preserve its ID so persisted grid cells remain associated. Removing a day/slot changes only plans created after the settings save; pinned active/historical plans retain their grid shape.
- Validate profile field lengths/counts and string normalization at the API boundary; retain hard dietary exclusions as explicit text without model rewriting.
- Audit hard-coded six-day/five-slot assumptions in evaluator, prompt/tool schemas, corpus schemas, plan rendering, Mini App display, and feedback target validation. Replace only assumptions incompatible with configurable schedules; retain school-specific safety policy where it is explicitly part of the product contract.
- Continue rejecting candidates with missing/extra schedule cells through deterministic evaluation. No LLM-controlled schedule or profile mutation is introduced.

### Mini App API and UI

- Add authenticated `GET /mini-app/api/profile` and `PUT /mini-app/api/profile` endpoints (or equivalent resource routes consistent with existing conventions). Use bounded JSON bodies, `no-store` responses, strict schemas, session-derived ownership, and stable generic error responses.
- Extend Mini App auth to support a settings-only session before a plan exists. The `/mealsettings` Telegram command responds only in the admitted user's private chat with a Web App button. Authenticate signed `initData`, require/derive private-chat scope from the signed launch context and verified admitted user, and load/create that user's profile without requiring `mini_app_review_context` or a `meal_plan` row. Persist the settings session with its server-derived `telegramUserId`/`chatId` and an explicit `scope: settings` discriminator. Add an additive migration making `plan_id` nullable only for settings sessions (enforce the discriminated invariant in code and schema constraints where supported); existing review sessions remain plan-scoped. Continue requiring an active matching plan/version for feedback; a settings session cannot submit feedback. The client never sends the owner/chat ID. If the signed launch context does not establish a private-chat owner, reject the launch.
- Add a settings route/view without disturbing plan review, history, or feedback flow. The client should use existing session token handling and should not persist profile contents in local/device storage.
- On profile save, return the canonical server state and new version. On version conflict, return a typed conflict that the UI handles with a reload/reapply path.

## 5. Delivery iterations

### Iteration 1 — Stable configurable schedule and lifecycle contract

- Add strict schedule/profile schemas and semantic validation; include all seven weekdays, variable slot counts, empty school-week days, and half-day subset behavior.
- Add plan schedule snapshots, mandatory legacy plan backfill, Sunday week bounds, and compatible store contracts/migration in D1 and in-memory implementations.
- Thread the captured schedule through initial-plan evaluation and atomic persistence. Pin feedback revision context, feedback-target validation, store acceptance in both backends, and plan rendering to the plan snapshot; changed settings are adopted only by a new plan.
- Replace seed-ID half-day branching with per-slot behavior while preserving the seed mapping.
- Audit planner/evaluator/rendering assumptions and update fixtures/corpus for representative schedules.
- Tests cover legacy active and historical plan freeze followed by day/slot edits; schedule save during generation; feedback after a slot is removed; new-plan adoption of changed settings; Sunday week resolution/expiry; custom-slot half-day evaluation and display; and unchanged seed behavior. Add end-to-end workflow coverage for a Sunday-containing custom schedule with a recurring half day and custom slot IDs, checking candidate shape, rendered plan, and Sunday expiry together.

### Iteration 2 — Authenticated profile persistence API

- Add atomic optimistic profile/configuration update to the store, including D1/in-memory parity, version conflicts, and mandatory legacy plan freeze before writes.
- Make legacy profile hydration a compare-and-set versioned write. Add tests for a delayed hydration racing with a successful configuration save and verify the winning configuration is never overwritten.
- Add `/mealsettings` private-chat launch and settings-only Mini App sessions; add authenticated profile read/write routes with strict request bounds, server-derived owner, and no-store headers. Keep review context optional only for settings sessions and keep feedback plan-scoped.
- Tests cover opening settings and saving before the first plan, private-chat enforcement, authorization/owner isolation, malformed/oversized payloads, stale version conflict, atomicity, and preservation of unexposed fields.

### Iteration 3 — Profile and schedule editing experience

- Add the Mini App settings navigation and forms for the supported profile fields and configurable day/slot/half-day schedule.
- Add save, loading, validation, conflict, and error states; preserve existing plan/review behavior and local feedback drafts.
- Add route/UI behavior tests or the project's closest automated coverage for settings-before-plan, schedule variations, profile save/reload, Sunday end-of-week expiry, and half-day custom slots; update the relevant product documentation and local acceptance steps.

## 6. Acceptance criteria

1. A user can edit and reload their profile and recurring schedule through the authenticated Mini App, including a chosen set of weekdays and a custom ordered slot list.
2. The initial seeded user sees the existing starter profile/schedule until they save a change.
3. Future plans are evaluated and rendered using the saved schedule; varied day counts and slot counts are accepted only when the candidate covers exactly that schedule.
4. Every legacy active and historical plan is frozen with the schedule as previously interpreted before profile edits become available; all plans continue to render with their original schedule after profile edits.
5. Profile state is isolated by authenticated owner; the client cannot read or mutate another owner's profile by changing request data.
6. Concurrent saves and legacy hydration do not silently overwrite each other, and invalid schedules/profile payloads are rejected before persistence.
7. There are no changes to production bindings, secrets, scheduled jobs, or Telegram allowlist policy in this iteration.

## 7. Validation and rollout

- Run focused store/schema/evaluator/Mini App route tests, then the repository's documented full quality gate (`pnpm check`) after implementation.
- Exercise settings launch and save before the first plan; first-use seed behavior; a no-snack two-day schedule; a one-snack weekday schedule; Sunday inclusion and Sunday edit expiry; slot add/rename/reorder/remove; seed and custom-slot half-day behavior; stale save conflict; and active/historical plan review after a schedule change.
- No new production configuration is expected. If implementation reveals a required Worker binding, `Env` variable, workflow, cron, or Durable Object change, stop and consult `docs/production-runtime-configuration.md` before changing it.

## 8. Review decision to resolve

Issue #70 explicitly describes editing the existing per-chat profile and schedule. This plan retains the current `TELEGRAM_ALLOWED_USER_ID` admission boundary and per-chat data model. The settings-only launch is restricted to that admitted user in the private bot chat; it does not add multi-user onboarding or public access.

