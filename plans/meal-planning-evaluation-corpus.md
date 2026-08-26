# Meal-Planning Evaluation Corpus and Deterministic Evaluator

> **Status:** Plan for GitHub issue #64 (parent: #59)
> **Document role:** Design of a reusable, runnable eval suite for the
> School-Day Meal Planning workflow: a structured corpus plus the
> deterministic `evaluateMealPlan` evaluator that checks it. No planning
> agent, no runtime review agent, no recipe-video or voice behavior.

## 1. Goal

Deliver the evaluation corpus described in issue #64 as a *runnable test
suite*, not just data:

- A machine-readable corpus of representative planning and revision
  scenarios with explicit expected assertions.
- A deterministic `evaluateMealPlan(candidate, context)` evaluator that the
  corpus tests drive directly.
- Tests that can run repeatedly in CI (`pnpm test`) and that also serve as
  offline human product review by being readable JSON.

The corpus evaluates multiple valid plans by their constraints and policy
outcomes; it never treats one exact meal grid as the only valid answer.

## 2. Scope and boundary

### In scope

- Corpus JSON fixtures for the 12 scenarios named in issue #64.
- Zod corpus schema + loader (`src/meal-planning/corpus/`).
- Deterministic evaluator `evaluateMealPlan` implementing the rules the
  planning-decisions document assigns to the evaluator: "normalized hard
  exclusions, the always-vegetarian workflow constant, configured days and
  slots, explicit packing/capacity fields, prior-night-prep count, declared
  morning-work total, and repeat measurements."
- Two vitest suites: corpus self-validation and scenario-runner evaluation.

### Out of scope (recorded, not built)

- The bounded planning-agent loop and its `evaluate_meal_plan` tool wiring.
- Any natural-language normalization/interpretation. **Boundary decided:**
  the corpus and evaluator operate on already-normalized structured data.
  The future agent normalizes free text into the tokens/vocabularies the
  fixtures declare; the evaluator only checks membership and arithmetic.
- Agent-behavior assertions (targeted clarification, truthfulness of a
  claimed policy outcome) are carried in the corpus declaratively for
  future agent integration tests and human review; they are not asserted by
  the deterministic suite.
- Recipe-video discovery, voice input, Telegram/Mini App surfaces.

## 3. Folder structure

Colocated under the future meal-planning module, mirroring `src/calendar/`
and the vitest conventions:

```text
src/meal-planning/
  types.ts                     # MealPlanContext, MealCell, MealPlanCandidate, Failure, Measurement
  evaluation.ts                # evaluateMealPlan(...)  — pure, deterministic
  corpus/
    schema.ts                  # zod schemas for fixtures
    load.ts                    # reads scenarios/*.json, zod-validates, returns typed scenarios
    scenarios/
      baseline-week.json
      dietary-ambiguity.json
      packing-constraints.json
      no-prior-night-prep.json
      urgent-perishables.json
      holiday-half-day.json
      policy-tradeoff.json
      new-food-setting.json
      requested-repeat.json
      midweek-shortage.json
      whole-day-replan.json
      batched-feedback.json
src/__tests__/
  meal-planning-corpus.test.ts         # schema + coverage validation
  meal-planning-evaluation.test.ts     # scenario runner over the corpus
```

No new top-level conventions and no new dependencies (zod is already a
dependency; the loader uses `node:fs` relative to `import.meta.url`).

## 4. Corpus schema

One fixture per scenario. Shape (abbreviated):

```jsonc
{
  "id": "baseline-week",
  "name": "Baseline week",
  "summary": "A normal Mon-Sat week, no exclusions beyond the vegetarian constant.",
  "context": {
    "schedule": {
      "days": ["Mon","Tue","Wed","Thu","Fri","Sat"],
      "slots": [
        { "id": "breakfast",     "name": "Breakfast",     "packed": false, "dry": false, "maxCookMinutes": null },
        { "id": "snack1",        "name": "Snack 1",       "packed": true,  "dry": true,  "maxCookMinutes": 0 },
        { "id": "snack2",        "name": "Snack 2",       "packed": true,  "dry": true,  "maxCookMinutes": 0 },
        { "id": "school-lunch",  "name": "School lunch",  "packed": true,  "dry": false, "maxCookMinutes": null },
        { "id": "home-lunch",    "name": "Home lunch",    "packed": false, "dry": false, "maxCookMinutes": null }
      ]
    },
    "profile": {
      "dietaryExclusions": [
        { "token": "peanut", "ambiguous": false },
        { "token": "egg", "ambiguous": false }
      ],
      "dishRepertoire": ["paratha", "banana", "roasted moong", "bottle gourd dal", "rice and beans"],
      "foodPreferences": { "favourites": ["paratha"], "avoid": [] },
      "allowNewFoods": false,
      "sensoryGuidelines": [],
      "morningCookingBudgetMinutes": 40,
      "priorNightPrepAllowed": false,
      "pantryBaseline": ["rice", "wheat flour", "oil", "spices", "moong dal", "ghee"],
      "allowFrequentIngredients": ["oil", "spices", "salt"]
    },
    "customPolicies": [
      { "id": "snack-policy", "label": "Snack policy", "scope": "persistent",
        "value": "School snacks should usually be dry, quick to pack, and not cooked that morning." }
    ],
    "weeklyInventory": {
      "items": [
        { "name": "bottle gourd", "status": "available", "useNote": "use early" },
        { "name": "beans", "status": "available" }
      ],
      "notes": []
    },
    "weeklyExceptions": {
      "items": [
        { "kind": "school_closed", "appliesTo": { "day": "Sat" }, "instruction": "Saturday is a holiday" }
      ]
    },
    "recentPlan": null,
    "request": { "kind": "initial_plan", "text": "Plan this week normally." }
  },
  "candidates": [
    {
      "label": "valid-basic",
      "plan": {
        "grid": {
          "Mon": {
            "breakfast":    { "dish": "paratha", "vegetarian": true, "items": ["wheat flour"], "cookMinutes": 15, "priorNightPrep": false },
            "snack1":       { "dish": "banana",  "vegetarian": true, "items": ["banana"], "cookMinutes": 0,  "priorNightPrep": false },
            "snack2":       { "dish": "roasted moong", "vegetarian": true, "items": ["moong dal"], "cookMinutes": 0, "priorNightPrep": false },
            "school-lunch": { "dish": "bottle gourd dal", "vegetarian": true, "items": ["bottle gourd","moong dal"], "cookMinutes": 20, "priorNightPrep": false },
            "home-lunch":   { "dish": "rice and beans", "vegetarian": true, "items": ["rice","beans"], "cookMinutes": 20, "priorNightPrep": false }
          }
        },
        "easyBuys": [],
        "policyOutcomes": { "snack-policy": { "outcome": "satisfied", "rationale": "Snacks are dry, uncooked, quick to pack." } }
      },
      "expect": { "pass": true, "measurements": { "morningCookMax": 35, "priorNightPrepMax": 0, "dishRepeatCount": 0, "principalIngredientMax": 2 } }
    },
    {
      "label": "invalid-missing-slot",
      "plan": { "grid": { "Mon": { /* no snack1 cell */ } }, "easyBuys": [], "policyOutcomes": {} },
      "expect": { "pass": false, "failures": [{ "code": "missing_slot", "day": "Mon", "slot": "snack1" }] }
    }
  ],
  "behavior": {
    "expectsClarification": false,
    "expectedPolicyOutcomes": { "snack-policy": "satisfied" }
  }
}
```

Key decisions baked into the schema:

- **Normalized only.** Ingredients, dishes, and inventory items are canonical
  tokens; each dietary exclusion is an object `{ token, ambiguous }`; the
  household dish repertoire is a `dishRepertoire` token list. The evaluator
  consumes `token` for membership checks and `ambiguous` only to suppress hard
  enforcement — it never interprets free text. All token matching (exclusions,
  ingredients, dishes, inventory) is **exact string equality**; normalizing
  free text into canonical tokens is an explicit agent-side precondition, not
  evaluator behavior. Each fixture's vocabulary is local to the fixture; no
  global taxonomy exists.
- **Cell `items` is the single list.** A cell carries one `items` list —
  everything the meal draws on — used for exclusion checks,
  principal-ingredient counting, and inventory availability alike; `ingredients`
  and `inventoryItems` were identical in every fixture and are merged here.
- **Vegetarian status is an evaluable constraint, not dead weight.** School
  meals are vegetarian by workflow constant, so a per-cell `vegetarian` flag
  (normally `true`) stays in the schema and `non_vegetarian_school_meal`
  rejects a cell that a future planner marks otherwise — a constant is exactly
  a constraint the evaluator must enforce, and removing the field would make a
  violating candidate unrepresentable and untestable. The corpus includes a
  violating candidate for it.
- **`allowFrequentIngredients`** keeps staples (oil, salt, spices, plus rice,
  wheat flour, moong dal in fixtures) out of the `principal_ingredient_overused`
  count (spec 6 variety rule); see §12 note 1.
- **Coverage set.** `missing_slot` is computed over configured days minus days
  marked `school_closed` (and minus slots dropped by `half_day` exceptions);
  `extra_slot_for_closed_day` forbids any cell on a closed day. The example's
  Saturday closure therefore requires Mon–Fri cells only and cannot produce
  simultaneous missing-slot and extra-slot failures.
- **`request.kind`** is `initial_plan` or `revision`. Revision fixtures
  carry `feedbackItems` (batched) and reference `recentPlan`, which enables
  revision-preservation and unaddressed-feedback checks.
- **`candidates`** always includes at least one `pass: true` plan and,
  where the rule set allows it, two or more distinct valid plans — this is
  how the corpus guarantees "multiple valid plans" are accepted.
- **`expect`** may assert exact failure sets and/or measurement bounds.
  `"noFailuresOf": ["hard_exclusion"]` supports negative assertions.
- **`behavior`** is declarative only (clarification expected, expected
  policy outcomes) and is not enforced by the deterministic suite.

## 5. Deterministic evaluator contract

```ts
export interface MealPlanContext { schedule; profile; customPolicies; weeklyInventory; weeklyExceptions; recentPlan?; request }
export interface MealPlanCandidate { grid; easyBuys: string[]; policyOutcomes: Record<string, PolicyOutcome> }
export type PolicyOutcome = { outcome: "satisfied" | "trade-off" | "needs-clarification"; rationale: string }

export interface MealPlanEvaluation {
  pass: boolean
  failures: MealPlanFailure[]
  measurements: MealPlanMeasurements
}

export type MealPlanFailure = {
  code: FailureCode
  day?: string
  slot?: string
  detail: string
}
```

`evaluateMealPlan(candidate, context)` is pure, synchronous, and returns
typed failures and measurements — never user-facing prose. It matches the
planning-decisions contract for the evaluator side of the loop.

## 6. Rule set

The evaluator owns only rules with structured, reliable semantics. Source
columns cite the spec (§) / planning-decisions (PD) / issue.

| Code | Rule | Source |
| --- | --- | --- |
| `hard_exclusion` | A cell `items` entry matches a `dietaryExclusions` entry's `token`. Entries with `ambiguous: true` are excluded from this check: the evaluator never enforces an ambiguous exclusion as hard. | spec 5.1, PD |
| `non_vegetarian_school_meal` | A configured school-day cell declares `vegetarian: false`. School meals are vegetarian by workflow constant, so this flags a planner violation rather than a normal input. | spec 5.1 (workflow constant) |
| `missing_slot` | A configured day × slot has no cell, where the coverage set is configured days minus days marked `school_closed` in `weeklyExceptions` and minus slots dropped by `half_day` exceptions (see §4). | issue ("slot coverage") |
| `extra_slot_for_closed_day` | A cell exists on a day marked `school_closed` in `weeklyExceptions`. Closed days contribute no required slots and no cells. | spec 5.3 |
| `morning_capacity_exceeded` | Combined morning cook minutes (breakfast + school lunch + any morning-cooked snack) on a day exceeds `morningCookingBudgetMinutes`. | spec 6 (combined workload), PD |
| `prior_night_prep_not_allowed` | A cell requires prior-night prep while `priorNightPrepAllowed: false`. | spec 5.4, PD |
| `prior_night_prep_limit` | A day has more than two `priorNightPrep: true` cells. | spec 6 |
| `slot_unsuitable` | A cell violates a declared slot constraint (e.g. a `dry`/`maxCookMinutes: 0` snack slot with `cookMinutes > 0`). | spec 6 (snacks, slot suitability) |
| `inventory_item_unknown` | A cell's `items` references an item not in `weeklyInventory` (available/low), `pantryBaseline`, or `easyBuys`. | spec 5.6, 6 (no-shopping default) |
| `inventory_item_unavailable` | A cell uses an item whose `weeklyInventory.status` is `unavailable` (midweek shortage). | spec 10 |
| `use_early_ignored` | A `useNote: "use early"` item's first use day is later than the fixture's `urgentUseByDay` (default Tue). Only enforced when the fixture sets `requireUrgentUseEarly`. | issue ("urgent perishables") |
| `dish_repeated` | The same named dish appears twice in the week, or repeats a `recentPlan` dish, unless it is a requested repeat or a configured favourite. | spec 5.7, 6 |
| `principal_ingredient_overused` | An item (outside `allowFrequentIngredients`) appears in more than two cells in the week, unless requested. | spec 6 |
| `unfamiliar_dish_not_allowed` | `profile.allowNewFoods: false` and a cell's `dish` is not in `profile.dishRepertoire` and not in any `recentPlan` dish. Familiarity is derived, never inferred. | spec 5.1, 6 |
| `unpaired_new_dish` | `profile.allowNewFoods: true` and a cell whose `dish` is not in the repertoire (nor `recentPlan`) appears on a day with no familiar cell on that day — new food must be paired with familiar food. | spec 5.1, 6 |
| `missing_policy_outcome` | A persistent-scope custom policy has no recorded `policyOutcomes` entry. Completeness only — truthfulness is agent/human territory. | issue, spec 5.11 |
| `unscoped_cell_changed` | For `request.kind: revision`, a cell outside the feedback scope differs from `recentPlan`. | spec 10 (smallest change) |
| `unaddressed_feedback` | A `feedbackItems` entry is referenced by no changed cell and by no `policyOutcomes` rationale. | spec 7 (batched feedback) |

### Measurements

`morningCookByDay` / `morningCookMax`, `priorNightPrepByDay` /
`priorNightPrepMax`, `dishRepeatCount` / `dishRepeats`,
`principalIngredientMax` / `principalIngredientOverused`, `inventoryUsed`,
`urgentUseByDay`, `easyBuyCount`. Scenarios assert bounds on these, which is
how capacity/prep and inventory state stay measurable without dictating a
single grid.

## 7. Scenario catalog

Each scenario exercises a distinct branch. At least one `pass: true`
candidate and at least one rule-violating candidate per scenario.

| # | Scenario | Intent | Rules exercised |
| --- | --- | --- | --- |
| 1 | baseline-week | Happy path: full five-slot week, no exclusions beyond the workflow's always-vegetarian constant. | zero failures; measurements within bounds |
| 2 | dietary-ambiguity | Exclusion objects with `ambiguous: true` must not be enforced as hard. Candidate A violates the clear exclusion (`peanut`) → `hard_exclusion`. Candidate B contains the ambiguous token (`dairy`) but is otherwise valid → passes, `noFailuresOf: ["hard_exclusion"]`. `behavior.expectsClarification: true`, subject: the ambiguous exclusion. | hard_exclusion (boundary), behavior |
| 3 | packing-constraints | Dry/quick snack slots and a "packing capacity" policy; cooked snack in a dry slot fails; policy outcome completeness. | slot_unsuitable, missing_policy_outcome |
| 4 | no-prior-night-prep | `priorNightPrepAllowed: false`; a required-prep cell fails; a >2/day prep plan fails. | prior_night_prep_not_allowed, prior_night_prep_limit |
| 5 | urgent-perishables | "Use early" items must appear by the fixture's `urgentUseByDay`; late use fails. | use_early_ignored |
| 6 | holiday-half-day | Saturday `school_closed`: coverage excludes Sat, and a Sat cell fails with `extra_slot_for_closed_day`. Wednesday `half_day` drops the `home-lunch` slot (via `appliesTo.mealSlots`): a plan omitting Wed home-lunch passes, while omitting a still-required Wed slot (e.g. `school-lunch`) fails `missing_slot`. | extra_slot_for_closed_day, missing_slot |
| 7 | policy-tradeoff | A policy in tension with a hard exclusion records `trade-off`; a plan claiming `satisfied` still passes the completeness check, while a plan with no recorded outcome fails. | missing_policy_outcome, hard_exclusion boundary |
| 8 | new-food-setting | `allowNewFoods: false`: a cell whose dish is not in `dishRepertoire` ∪ `recentPlan` dishes fails with `unfamiliar_dish_not_allowed`. `allowNewFoods: true`: a new dish passes when its day has at least one familiar cell; a new dish on a day with no familiar cell fails with `unpaired_new_dish`. Familiarity is derived from `dishRepertoire` + `recentPlan`, never inferred. | unfamiliar_dish_not_allowed, unpaired_new_dish |
| 9 | requested-repeat | A requested repeat overrides the anti-repeat rule; an unrequested repeat still fails. | dish_repeated (requested vs not) |
| 10 | midweek-shortage | "Out of paneer" inventory patch; revision swaps only the affected cell and preserves the rest. | inventory_item_unavailable, unscoped_cell_changed |
| 11 | whole-day-replan | "This whole day looks untenable" permits a full-day change while other days stay unchanged. | unscoped_cell_changed (scoped relaxation) |
| 12 | batched-feedback | Multiple feedback items submitted together; revision addresses each or records a trade-off/needs-clarification. | unaddressed_feedback |

## 8. Test suite design

### `src/__tests__/meal-planning-corpus.test.ts` (corpus health)

- Every fixture parses and validates against the zod schema.
- The 12 required scenario ids are present.
- Coverage lint: every failure code in §6 — including `unfamiliar_dish_not_allowed`
  and `unpaired_new_dish` — is exercised by at least one candidate's expected
  failures; every scenario has at least one `pass: true` candidate; revision
  scenarios reference `recentPlan` + `feedbackItems`.

### `src/__tests__/meal-planning-evaluation.test.ts` (scenario runner)

- For each scenario × candidate, run `evaluateMealPlan(candidate, context)`
  and assert the `pass` flag and exact failure set (or `noFailuresOf`), plus
  the declared measurement bounds.
- Distinct valid candidates per scenario prove non-canonicality at the test
  level: the evaluator accepts more than one grid.

Both suites are deterministic, mock-free, and run under `pnpm test`.

## 9. Multi-valid-plan guarantee

- Assertions are predicates over a candidate, not equality to one grid.
- Each scenario ships two or more distinct `pass: true` candidates where the
  rule set admits them.
- Bounds (capacity, repeats, inventory) are measured, not matched to a fixed
  menu.

## 10. Validation

```bash
pnpm typecheck
pnpm lint
pnpm test              # runs the two new suites
```

`lefthook` pre-commit runs typecheck, lint, and all test suites; this lane's
plan commit is documentation-only and does not touch `src/`, so the gates
are informational for the plan itself.

## 11. Follow-ups (separate issues)

- Wire `evaluateMealPlan` as the deterministic `evaluate_meal_plan` tool in
  the bounded planning-agent loop (child of the meal-planning epic).
- Agent integration tests that consume `behavior` assertions (clarification,
  policy-outcome truthfulness) once the agent loop exists.
- Recipe-video, voice, and Mini App review behaviors are tracked elsewhere.

## 12. Open questions

None blocking. Two notes for review:

1. `principal_ingredient_overused` (spec 6 variety rule) counts every cell
   `items` entry; the `allowFrequentIngredients` fixture list keeps staples
   (oil, salt, spices — plus rice, wheat flour, moong dal in fixtures) out of
   the count. If review prefers a `principal: true` flag per cell, that is a
   small schema change.
2. `slot_unsuitable` is limited to *declared* facts (slot `dry` /
   `maxCookMinutes` vs cell `cookMinutes`); leak-prone or packaging
   suitability remain custom-policy semantics owned by the agent, matching
   the normalization boundary decision.
