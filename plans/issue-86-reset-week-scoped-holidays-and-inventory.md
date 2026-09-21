# Reset Week-Scoped Holidays and Inventory for Each New Meal Plan

> **Status:** Plan for GitHub issue #86 (`Reset week-scoped holidays and inventory
> for each new meal plan`).
> **Document role:** Design of the fix that stops a new initial plan from
> inheriting the previous plan's `weeklyInventory` / `weeklyExceptions`, and that
> makes the initial-plan EasyBuys list a deterministic function of the hydrated
> candidate and the fresh week context.

## 1. Problem

Starting a new initial meal plan can inherit week-scoped state from the previous
plan. Observed symptoms:

- The previous week's Monday `school_closed` holiday reappeared in the following
  week's plan even though the new request did not mention a holiday.
- The EasyBuys list was incomplete. Ingredients reported available last week
  remained "available" in the new planning context, so the planner omitted
  purchases needed for the new plan. The observed cases were Patta Gobi Matar
  (no peas), Paniyaram (no idli batter), and French Beans Subzi (no French
  beans).

Both symptoms are wrong relative to the documented contract. The Telegram test
plan already states (`docs/school-day-meal-planning-telegram-test-plan.md`, S04):

> Start a new planning week. `weeklyInventory` and `weeklyExceptions` expire;
> durable household configuration and previous-plan variety context remain
> available.

## 2. Root cause

Two independent leaks, both in the initial-plan path.

### 2.1 The initial context copies the previous plan's week-scoped state

`src/meal-planning/agent-workflow.ts` builds the initial context from the most
recent active plan (lines 240–251):

```ts
weeklyInventory: recent?.plan.weeklyInventory ?? { items: [], notes: [] },
weeklyExceptions: recent?.plan.weeklyExceptions ?? { items: [] },
```

`store.activePlan(chatId)` returns the active plan regardless of its target
week. When `/mealplan` resolves a new target week, the previous week's plan is
still `status = 'active'` (it is only marked `replaced` when the new plan is
created), so its inventory and holidays seed the new context.
`extractInitialWeekContext` then only *merges* the new request's facts on top
(`src/agent/meal-planning-session.ts`, `resolveWeekContextUpdate`, lines
313–366): it upserts inventory names and appends exception additions. It never
resets the context for a different target week. With no request text, the leaked
state survives untouched.

`recentPlan` (variety) is separate and must keep crossing weeks; the bug is only
`weeklyInventory` and `weeklyExceptions`.

### 2.2 The initial path trusts the model's EasyBuys list

`src/meal-planning/evaluation.ts` has two entry points:

- `evaluateMealPlanSelectionPatch` (revisions, lines 62–89) hydrates the patch,
  then runs `reconcileEasyBuys(hydration.candidate, context)` and evaluates the
  reconciled candidate.
- `evaluateMealPlanSelection` (initial plans, lines 34–59) hydrates and
  evaluates the candidate directly, keeping the model's `easyBuys`.

Because `hydrateMealPlan` resolves required ingredients against
`weeklyInventory` + `pantryBaseline` + the model's `easyBuys`
(`src/meal-planning/hydration.ts`, lines 101–111), the leaked prior-week
inventory made hydration pass and the model had no reason to add the ingredient
to EasyBuys. The persisted plan then had no peas, idli batter, or French beans.
The initial path never applied the deterministic reconciliation that already
covers revisions (`src/meal-planning/easy-buys.ts`).

## 3. Design

### 3.1 Week-scope the initial-plan context (`src/meal-planning/agent-workflow.ts`)

Seed `weeklyInventory` / `weeklyExceptions` from the recent plan only when the
recent plan targets the *same* planning week; otherwise start empty.

```ts
const sameWeek = recent?.plan.weekStart === week.weekStart
const baseContext: MealPlanContext = {
  schedule: profile.schedule,
  profile: profile.profile,
  customPolicies: profile.customPolicies,
  // Week-scoped facts belong to the target week only: a plan for another week
  // must not donate its inventory or holidays to a new initial plan.
  weeklyInventory: sameWeek ? recent.plan.weeklyInventory : { items: [], notes: [] },
  weeklyExceptions: sameWeek ? recent.plan.weeklyExceptions : { items: [] },
  recentPlan: recent?.version.candidate.grid ?? null,
  provisionalMealDefinitions: [],
  request: { kind: "initial_plan", text: event.payload.requestText },
}
```

Notes:

- The comparison is exact string equality on the already-canonical ISO
  `weekStart` produced by `resolvePlanningWeek` and persisted by
  `createActivePlan`.
- `recentPlan` stays unconditional: cross-week variety needs the prior grid
  (`evaluateMealPlan` derives `recentDishes` from it), and the issue explicitly
  allows previous-plan variety context.
- Same-week re-invocation keeps the target week's facts. Example: `/mealplan` on
  Thursday plans next week; a second `/mealplan` on Friday resolves the same
  target week and should not discard inventory reported the day before. Only a
  *different* target week resets.
- `provisionalMealDefinitions` already resets to `[]`; no change.
- `customPolicies` are household/profile-owned, not plan-scoped. `current_week`
  scoped policies are not written or cleared anywhere in the current code, so
  they are out of scope (see §7).

Extraction then runs against the fresh context and only adds facts the new
request states, including an explicitly restated holiday ("unless explicitly
restated").

### 3.2 Deterministically reconcile initial-plan EasyBuys (`src/meal-planning/evaluation.ts`)

Make the initial path mirror the revision path: hydrate allowing missing
required ingredients, then reconcile EasyBuys from the hydrated candidate and
the fresh week context, then evaluate the reconciled candidate.

```ts
export function evaluateMealPlanSelection(
  selectionCandidate: MealPlanSelectionCandidate,
  context: MealPlanContext,
): MealPlanSelectionEvaluation {
  // allowMissingRequiredIngredients: ordinary ingredients the model did not
  // list are shopping items, not hydration failures; the deterministic
  // reconcile below derives the authoritative list from the hydrated grid.
  const hydration = hydrateMealPlan(selectionCandidate, context, undefined, true)
  if (!hydration.candidate) {
    return { ...hydration, evaluation: /* unchanged empty measurements */ }
  }
  const candidate = reconcileEasyBuys(hydration.candidate, context)
  return { ...hydration, candidate, evaluation: evaluateMealPlan(candidate, context) }
}
```

Why this shape:

- `reconcileEasyBuys` (`src/meal-planning/easy-buys.ts`) already defines the
  contract the issue asks for: every cell item not in the week's inventory
  (status ≠ `unavailable`) or pantry baseline, deduplicated, in grid order; and
  no stale entry survives a replaced cell. Reusing it keeps one definition of
  "the required shopping list" for both initial plans and revisions.
- Passing `allowMissingRequiredIngredients = true` is what makes reconciliation
  *authoritative* rather than dependent on the model echoing the right names.
  This is exactly how `hydrateMealPlanPatch` already calls `hydrateMealPlan`
  (`src/meal-planning/hydration.ts`, lines 287–296). Catalog-meal ingredients
  (peas, idli batter, French beans) are therefore always covered even when the
  model's list is short.
- Explicitly `unavailable` ingredients still fail hydration with
  `required_ingredient_unavailable` (the unavailable branch is independent of
  `allowMissing`), and structural failures (`unknown_meal_definition`,
  `invalid_ingredient_choice`, `invalid_ingredient_alias`, `packed_slot_unsuitable`,
  duplicate selections) still gate. No plan is persisted on those failures.
- The terminal `propose_plan` candidate in
  `src/agent/meal-planning-session.ts` already comes from
  `selectionEvaluation.candidate`, so persisting the reconciled candidate needs
  no workflow change.

Prompt alignment: the initial-plan prompt currently tells the model to "verify
every required ingredient against the context's weekly inventory, pantry
baseline, or easy buys" (`MEAL_PLANNING_AGENT_PROMPT`, line 55) and describes
`easyBuys` as the model's list (line 61). With server reconciliation the list is
advisory. Add one sentence to the initial-plan guidance — the server reconciles
`easyBuys` from the hydrated plan and the week's inventory/pantry before
persisting, so the model should still name ordinary additions but not assume its
list is authoritative. This is a small wording change, not a new contract.

## 4. File-level change list

| File | Change |
| --- | --- |
| `src/meal-planning/agent-workflow.ts` | Gate the initial `weeklyInventory` / `weeklyExceptions` seed on `recent.plan.weekStart === week.weekStart`; keep `recentPlan` unconditional. |
| `src/meal-planning/evaluation.ts` | `evaluateMealPlanSelection`: hydrate with `allowMissingRequiredIngredients = true`, `reconcileEasyBuys`, evaluate the reconciled candidate; update the JSDoc to describe initial-path reconciliation. |
| `src/agent/meal-planning-session.ts` | One-sentence prompt clarification that the server reconciles initial-plan `easyBuys`. |
| `src/__tests__/meal-planning-evaluation.test.ts` | Unit regressions for fresh-week ingredient availability and initial EasyBuys reconciliation. |
| `src/__tests__/meal-planning-workflow.test.ts` | Workflow regressions for cross-week context reset, same-week retention, and revision retention. |

No `Env`, binding, workflow, cron, or Durable Object change; no
`config/runtime-variables.json` or `wrangler.prod.toml` change.

## 5. Regression tests

Each test maps to an acceptance criterion.

1. **Prior Monday holiday does not leak into the following week** (workflow).
   Seed a prior active plan whose `weekStart` is the *previous* week with a
   `school_closed` exception on `Mon` and inventory containing peas, idli batter,
   and French beans. Run a new initial plan for the target week with no request
   text. Assert the first provider request's household context does not contain
   the prior holiday or those inventory names, and that persisted
   `weeklyExceptions.items` / `weeklyInventory.items` contain only what the new
   request stated (empty when it stated nothing).

2. **Prior-week inventory does not satisfy new-week requirements** (unit +
   workflow). Unit: `evaluateMealPlanSelection` with an empty new-week
   `weeklyInventory`, a definition requiring `peas`, and a selection whose
   `easyBuys` omits it must still produce a candidate whose reconciled
   `easyBuys` contains `peas` (no `required_ingredient_unavailable`). Add the
   paired negative: the same selection with the ingredient marked
   `unavailable` fails hydration and produces no candidate.

3. **Observed peas / idli batter / French beans cases** (unit). With a fresh
   week context (empty inventory) and established definitions for Patta Gobi
   Matar (`peas`), Paniyaram (`idli batter`), and French Beans Subzi
   (`french beans`), a selection that omits all three from `easyBuys` still
   yields a persisted candidate whose `easyBuys` equals those three (plus any
   other non-inventory cell items), proving deterministic coverage. Include a
   stale entry in the model's `easyBuys` (an item no cell uses) and assert it is
   dropped.

4. **Initial EasyBuys are reconciled against the hydrated candidate** (unit).
   Assert `evaluateMealPlanSelection(...).candidate.easyBuys` equals the set of
   cell items not in `weeklyInventory` (available/low) or `pantryBaseline`, in
   grid order, and that `evaluation.pass` is computed on that reconciled
   candidate.

5. **Same-week re-invocation keeps the target week's facts** (workflow). Seed a
   prior active plan with the *same* `weekStart` and inventory; run a new initial
   plan; assert the prompt still contains that inventory (week-scoped reuse).

6. **Same-plan revisions retain their own week-scoped state** (workflow).
   After an initial plan, drive a feedback revision and assert the revision
   prompt and promotion still use the active plan's `weeklyInventory` /
   `weeklyExceptions` (existing `runRevision` path is unchanged; pin it).

7. **Cross-week variety still sees the prior plan** (workflow). In test 1,
   assert the prompt *does* include the prior plan's dish names (the
   `Recent plan` block) while excluding the prior week's holiday and inventory.

8. **No plan persisted on a hard failure** (existing + unit). Keep/extend the
   `required_ingredient_unavailable` case: an explicitly unavailable ingredient
   (and unknown definition / invalid choice) makes `propose_plan` throw and no
   active plan is written.

Normalization coverage: keep the existing singular/plural tests
(`normalizeIngredient`) and the alias tests green; reconciliation must not
re-buy an item that hydration resolved through inventory or a genuine alias
(assert the alias-resolved spelling is excluded from `easyBuys`).

## 6. Verification

```bash
pnpm test src/__tests__/meal-planning-evaluation.test.ts \
         src/__tests__/meal-planning-workflow.test.ts \
         src/__tests__/meal-planning-agent.test.ts
pnpm check   # biome lint, JSDoc check, tsc --noEmit, full unit suite
```

`pnpm test:integration` for the Telegram meal-planning integration test should
also be run; it exercises the workflow through D1 and the in-memory store.

## 7. Out of scope

- `current_week` custom policies: nothing in the current code writes or expires
  them, so there is no week-scoped policy leak to fix here.
- Any change to revision semantics; revisions already reconcile EasyBuys and
  already read their own plan's week state.
- Changing the EasyBuys cap, prohibited-item policy, or the evaluator's
  `inventory_item_unknown` / `dish_repeated` rules.
- Live-model contract tests (`test:meal-contract`) are opt-in and may need a
  follow-up review after the prompt wording change; they are not a merge gate.

## 8. Decisions for review

1. **Same-week reuse vs. always-empty.** The plan resets only when the recent
   plan targets a different week. Always resetting would discard facts reported
   earlier in the same target week (e.g. a Thursday plan for next week followed
   by a Friday re-invoke for the same week). The issue's wording ("does not
   reset the context for a new target week") and S04 both support the week gate.
2. **`allowMissingRequiredIngredients = true` on the initial path.** This makes
   the server, not the model, authoritative for the shopping list, matching the
   issue's "deterministically reconciled" requirement and the observed
   catalog-meal cases. The hard gate for explicitly unavailable ingredients is
   unchanged. The alternative — keep the strict hydration gate and rely on the
   model to name every ingredient — was rejected because it leaves the observed
   cases dependent on model compliance rather than a deterministic guarantee.

## 9. Acceptance criteria

- [ ] A prior Monday holiday does not affect a new initial plan for the
      following week unless the new request explicitly restates it.
- [ ] Prior-week inventory does not satisfy new-week ingredient requirements.
- [ ] The observed peas, idli batter, and French beans cases produce the
      required EasyBuys entries when not newly supplied.
- [ ] Initial-plan EasyBuys are deterministically reconciled against the
      hydrated candidate and the fresh weekly context.
- [ ] Same-plan revisions continue to retain their own week-scoped inventory and
      exceptions.
- [ ] Cross-week variety still receives the prior-plan meal context without
      importing week-scoped facts.
- [ ] No plan is persisted when the candidate fails hydration or an ingredient
      is explicitly unavailable; the persisted EasyBuys always covers every
      required ingredient not in the new week's inventory or pantry baseline.
- [ ] Singular/plural normalization and genuine ingredient aliases continue to
      work.
