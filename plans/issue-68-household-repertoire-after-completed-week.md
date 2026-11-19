# Issue #68 — Add newly tried dishes to the household repertoire after an approved, completed week

## Goal

After a planning week has elapsed, promote eligible newly introduced dishes from that week's final plan into the household's established meal catalog. Promotion is based on the exact final version and the historical new-food policy that applied when it was planned. It must be repeat-safe and must not let a later profile-policy change rewrite the decision for an already-planned week.

The issue's rule is: consider an active plan after `week_end` when its final version was either revision-free or explicitly accepted. “Tried” is best-effort: an approved plan plus the elapsed week is sufficient evidence that its planned dishes were implemented. Partial weeks are not inferred as fully cooked from telemetry; after the elapsed-week gate, the plan's final grid is the candidate set, with explicitly rejected dishes removed.

## Current architecture and constraints

- `MealProfile.mealDefinitions` owns the durable household catalog. Definitions carry `established` or `provisional` status; `dishRepertoire` is deprecated.
- New definitions are stored as plan-local provisional definitions in immutable `meal_plan_version` snapshots. Revisions inherit previous provisional definitions even when a definition is no longer present in the grid (`src/meal-planning/hydration.ts`), so promotion must join against the final grid rather than promote the entire snapshot.
- A plan stores its current version and may be changed by a CAS-guarded revision. Creating another plan replaces the previous active plan regardless of its week. Initial and revision workflow runs are bounded and finish after sending the plan; no existing live process remains to run at `week_end`.
- The household catalog is persisted in `meal_profile.profile_json`; the store has D1 and in-memory implementations. The store is the trust boundary for atomic checks and profile writes.
- Existing planner validation and catalog conversion in `src/meal-planning/catalog.ts` must remain authoritative. A completion job must not accept client-authored meal definitions.
- Durable workflow operations replay. Completion processing must be idempotent and must couple eligibility checks to the profile write so an approval change, revision, or concurrent profile write cannot produce an invalid promotion.

## Proposed design

### 1. Persist version-scoped approval and historical policy

Add forward-only persistence for the decision inputs on each plan version:

- `allow_new_foods_snapshot`: the boolean profile policy used to evaluate that version. Populate it on initial plan creation and each successful revision from the exact profile/context used for that run. Do not read the current profile setting when processing a completed week.
- `approved_version`: a plan-level nullable version pointer (or equivalent explicit approval record). Initial version is approved when created, matching the existing “created plan is approved by default” behavior. A successful revision clears approval of the prior version and leaves the new version pending acceptance. An authenticated parent “Accept this version” action sets the pointer only if the submitted plan ID/version is still the active current version. Explicit rejection clears approval for that exact version; stale acceptance/rejection actions do nothing.
- `rejected_meal_ids`: durable, plan-scoped rejection evidence. Add an authenticated structured rejection action for a dish shown in the plan, and persist the canonical provisional meal ID. Preserve these IDs through revisions. If existing free-text feedback explicitly rejects a dish, implementation may map it only when it unambiguously names a provisional definition; ambiguous text must not be guessed. Rejection applies across versions of the same plan and is irreversible for that plan.

A version is eligible for approval at completion when it is the final current version and either no revision was ever made (version 1 remains approved by creation) or the current version was explicitly accepted. Any revision invalidates the preceding version's approval. A rejection of the current version makes that version ineligible until a later version is accepted. A later version does not erase prior dish rejection evidence.

Legacy versions with no policy snapshot are ineligible for automatic promotion. This fail-closed behavior avoids applying today's policy retroactively. Existing rows with no approval metadata are likewise ineligible unless the store can prove their version-1 revision-free status from existing authoritative data and the issue explicitly permits that compatibility path.

### 2. Run completion on a scheduled path and preserve eligible history

Add a scheduled Worker trigger at a bounded interval to find plans whose `week_end` has elapsed and process them. Read `docs/production-runtime-configuration.md` before implementation because this adds/changes a cron trigger; update `wrangler.prod.toml`, `Env`/runtime-variable registry and provisioning only if required by the selected implementation. Do not leave completion dependent on a workflow that currently exits after publishing.

The completion query considers the latest plan for each chat/week, even if that plan later has status `replaced` because the household started another week. This preserves a completed prior week until the scheduler catches up. It excludes an older plan version chain for the same week when a later replacement plan exists for that same chat/week. A plan superseded by a different week's plan remains eligible based on its own week and final version. Keep the completion marker on the plan (or a small durable completion ledger) so delayed scheduler runs can recover it.

The scheduled processor passes `(chat_id, plan_id, expected_current_version, approved_version, week_end)` to one store transaction. The store reads the plan/version evidence and current profile version, derives candidates by joining final-grid dish names/IDs to that version's provisional definitions, then removes plan-scoped rejected IDs and definitions already represented by stable ID or normalized name/alias. It attempts a profile-version compare-and-set that merges those definitions into the just-read profile only while the plan guards still hold: week end is due; the target is still the latest plan for that chat/week; expected version is still current; it is approved under the rule above; policy snapshot permits new foods; and it has not already been processed. Couple the successful profile update to the completion marker in the same SQLite transaction (for D1, use a guarded SQL statement/trigger or equivalent atomic mechanism, not separate read-then-write calls). If the profile version changed, retry from a fresh profile read; if any plan guard fails, make no profile or completion-state change.

A revision or same-week replacement racing completion changes the current/latest-version guard and makes the old completion attempt a no-op. A different-week plan replacement does not make an otherwise eligible past week disappear. A profile update racing completion is serialized by the same D1 transaction, and the merge starts from the profile row as it exists inside that transaction. Replayed jobs observe the processed marker and do nothing. Delayed processing after `week_end` is allowed if all durable eligibility facts still match.

### 3. Derive only dishes represented in the final grid

Use the final version's grid as the source of planned dishes. Resolve each cell's canonical dish against that version's provisional definitions, including the existing normalized aliases where needed. Promote only definitions referenced by at least one final-grid cell. Definitions inherited from an earlier revision but dropped from the final grid are not candidates. Existing established definitions are never demoted or rewritten.

Convert eligible definitions through existing trusted establishment semantics, preserving the validated ingredients, slot suitability, and preparation attributes. Deduplicate deterministically against current established definitions by stable ID and normalized name/aliases. Do not alter immutable version JSON. A missing/invalid definition mapping is skipped and logged as a typed completion failure, not synthesized from the dish label.

### 4. Report the result narrowly

The scheduled path has no synchronous parent request. Record a compact processed result (added names/count, skipped count, and reason category) sufficient for runtime diagnostics and retry investigation. Do not store provider prose or duplicate full definition payloads in a new log. A user-facing notification is out of scope unless issue acceptance explicitly requires it.

## Implementation areas

- `migrations/`: add the version policy snapshot, version approval/rejection state, and plan completion state/ledger with safe defaults for legacy rows.
- `src/meal-planning/store.ts`: add approval/rejection methods and one atomic `completeEligiblePlan` operation; implement the same guards and merge in D1 and in-memory stores.
- `src/meal-planning/agent-workflow.ts`, Worker scheduled entry point, and runtime types/configuration: persist the policy snapshot on every version, expose authenticated accept/reject actions, and dispatch due-plan processing.
- `src/meal-planning/types.ts`, `src/meal-planning/catalog.ts`, and hydration: preserve trusted definition conversion and use final-grid references for eligibility.
- Store, workflow, Worker scheduled-trigger, and migration tests: exercise transition guards and concurrency boundaries.

## Acceptance criteria for implementation

- No repertoire mutation occurs before the plan's `week_end`.
- A revision-free version 1 is eligible under the existing default-approved behavior; after any revision, only the explicitly accepted current final version is eligible. Stale accept/reject actions cannot change the current plan's approval.
- The policy snapshot, not the current household setting, determines eligibility. Missing historical policy evidence fails closed.
- Candidate dishes come from the approved final grid intersected with its provisional definitions; dropped definitions and explicitly rejected meal IDs are excluded.
- A different-week replacement cannot erase a due eligible week before processing; a newer plan for the same week supersedes the older chain. Revisions/replacements racing the transaction fail the expected-version/latest-plan checks.
- Delayed and replayed scheduler delivery is safe. Profile changes are merged without overwriting concurrent preference, policy, or catalog changes.
- Promoted definitions become available to later plans, retain existing validation constraints, and do not mutate historical plan versions.
- D1 and in-memory behavior match. Tests cover policy changes, absent policy, initial versus revised approval, rejection, final-grid intersection, replacement, same-week supersession, races, and replay.

## Validation

During implementation, run focused store/workflow/scheduled-trigger tests and migration tests, then `pnpm check` and the relevant integration suite. Because the design adds a scheduled trigger, follow the production runtime configuration documentation and verify the deployment manifest and runtime-variable registry/provisioning impact. This planning turn makes no runtime configuration changes.
