# Issue #98 Plan: Use the Lightweight Classifier for the Remaining Semantic Meal-Plan Validations

## Goal

Use the existing lightweight Decisions classifier for the three semantic checks
that remain outside deterministic evaluation: actual meal suitability for packed
slots, truthfulness of persistent-policy outcomes, and whether a revision
addresses each applicable authoritative feedback item. Keep structured catalog,
schedule, inventory, scope, and change-detection rules deterministic.

## Current state

- `evaluateMealPlan` is pure and synchronous. It checks structured facts,
  including declared slot constraints, catalog meal facts, policy-outcome
  presence, feedback scope, changed cells, and whether a feedback ID appears in
  a rationale.
- The evaluation corpus leaves real-world packing suitability and truthfulness
  of free-form policy and feedback claims to semantic judgment. Those checks
  are intentionally not part of deterministic evaluation or its corpus.
- `createEasyBuyClassifier` batches `noul` questions through Decisions and
  rejects uncertain answers. `runMealPlanningAgentSession` currently awaits the
  easy-buy classifier directly; classifier/provider errors therefore do not
  yet become evaluation failures that a proposal can return to the planner.

## Design

### Three semantic checks

1. **Packed-slot meal suitability.** For every meal in every applicable packed
   slot, judge the actual meal and its described components against the slot's
   use. This runs even when there is no custom packing policy. Check ordinary
   lunchbox travel; dry-slot requirements; independent eating by hand or an
   ordinary spoon; and whether the meal needs reheating, cooking, assembly, or
   special equipment. Catalog `packedFood.suitable` and `packedFood.dry` facts
   remain deterministic hard checks and are evaluated before semantic
   suitability. A semantic pass cannot override a catalog failure.
2. **Persistent-policy outcome truthfulness.** For every persistent policy,
   judge whether the hydrated plan supports its recorded `satisfied` or
   `trade-off` claim. Supply the policy text, recorded outcome and rationale,
   and the plan cells relevant to that policy. Retain the deterministic
   requirement that every persistent policy has an outcome. Do not classify
   ephemeral policies as persistent.
3. **Authoritative feedback satisfaction.** For every applicable authoritative
   feedback item in a revision, judge whether the revision addresses the item's
   text. Supply its target and scope plus the relevant before-and-after cells;
   include any cited policy outcome or rationale. Keep deterministic reference,
   scope, and changed-cell checks. A feedback ID mentioned in a rationale or
   an unrelated edit is not, by itself, evidence that the request was met.
   Perform the semantic check even when deterministic checks pass.

### Async boundary and failure behavior

- Keep `evaluateMealPlan` and the evaluation corpus offline, pure, and
  deterministic. Add distinct typed semantic failure codes at the asynchronous
  session boundary for unsuitable packed meals, unsupported policy outcomes,
  unaddressed feedback, and inability to verify a semantic check. Include the
  check kind and affected slot, policy, or feedback ID in failure details.
- Run deterministic evaluation first. Only when it passes, build a single
  batched Decisions request for applicable semantic checks. Validate answer
  shape and confidence. Explicit pass yields no failure; explicit fail yields
  that check's actionable failure; uncertain or missing/malformed answers
  yield the inability-to-verify failure for that check.
- Catch Decisions request and transport errors at this async boundary and
  convert them to inability-to-verify failures for all checks in the failed
  batch. Return those failures as an ordinary failed evaluation so the agent
  can retry with a corrected plan or ask for clarification. Do not allow
  `propose_plan` to persist if any semantic check failed or could not be
  verified. Never turn a provider error into a pass.
- Preserve candidate-keyed memoization only for unchanged evidence. The final
  proposal must validate the same authoritative context and reuse semantic
  verdicts only if its hydrated candidate and relevant evidence match the
  evaluated candidate. Otherwise reclassify. Include Decisions usage/cost for
  successful responses; failed requests contribute no fabricated usage.
- Preserve existing hard-exclusion behavior for unambiguous exclusions.
  Ambiguous exclusion language remains a planner clarification; do not add it
  to the classifier checks.

### Decision examples

- **Packed-slot pass:** a dry, hand-held snack that travels in an ordinary
  lunchbox, needs no reheating or assembly, and is suitable for its dry slot.
- **Packed-slot fail:** a wet curry in a dry packed-snack slot, or a packed meal
  that requires reheating or special equipment to eat.
- **Policy pass:** a persistent policy asks for quick, dry snacks and the
  relevant planned snacks are dry and quick; the recorded `satisfied` outcome
  is supported.
- **Policy fail:** the same policy is recorded as `satisfied` while a relevant
  planned snack is cooked slowly and is wet; the claim is unsupported.
- **Feedback pass:** authoritative feedback asks to replace Monday breakfast,
  and the before/after evidence shows that exact scoped cell changed to a
  responsive meal.
- **Feedback fail:** feedback asks to replace Monday breakfast, but the
  revision changes Tuesday lunch and cites the feedback ID in a rationale. The
  unrelated edit does not address the request.
- **Uncertain or malformed answer:** return the inability-to-verify failure
  for each affected check; evaluation fails and the proposal is rejected.
- **Request/transport error:** map the failed batch to inability-to-verify
  failures for all applicable checks in it; evaluation fails and the proposal
  is rejected. A later successful retry may re-evaluate the candidate.

## Implementation iterations

1. **Packed-slot suitability.** Add the async check builder and failure mapping
   for packed-slot meals, preserving deterministic catalog suitability/dry
   checks. Cover ordinary lunchbox travel, dry slots, independent eating, and
   reheating/cooking/assembly/equipment needs.
2. **Policy truthfulness.** Add per-persistent-policy evidence construction and
   classification of `satisfied`/`trade-off` claims, retaining deterministic
   outcome completeness. Verify that unsupported claims fail with the policy
   ID and relevant evidence.
3. **Feedback satisfaction and final gate.** Add per-item before/after
   evidence, async-boundary failure handling, proposal gating, evidence-safe
   memoization, usage behavior, and integrated regressions across all three
   checks. Keep feedback reference/scope/change checks deterministic.

## Acceptance criteria

- Every applicable packed-slot meal is semantically checked, including when no
  packing custom policy exists. Ordinary lunchbox travel, dry-slot needs,
  independent eating, and reheating/cooking/assembly/equipment requirements
  are all represented. Catalog `packedFood.suitable` and `.dry` remain
  deterministic gates.
- Each persistent policy's recorded `satisfied` or `trade-off` outcome is
  checked against the plan, policy text, and rationale; outcome completeness
  remains deterministic.
- Every applicable authoritative feedback item is checked against its text,
  target/scope, and relevant before-and-after cells, with cited outcomes or
  rationales included as evidence. An unrelated edit or bare feedback-ID
  reference does not satisfy it.
- Deterministic reference and changed-cell checks remain in place, and
  semantic verification runs even if those checks pass.
- Clear semantic pass/fail, uncertain/malformed answers, and request/transport
  errors all produce the specified outcomes. Any failure or unverifiable check
  makes evaluation fail and prevents proposal persistence with an actionable
  failure detail.
- Ambiguous hard exclusions continue to request planner clarification; no
  principal-ingredient variety classifier is introduced.
- The deterministic evaluator and corpus remain offline and unchanged in role;
  session tests cover the asynchronous classifier boundary, memoization,
  usage, repairs, and final proposal gating.

## Validation

Run focused tests for the meal-planning classifier/session and workflow, then
`pnpm typecheck`, `pnpm lint:ci`, `pnpm docs`, and `pnpm test`. Keep
`meal-planning-evaluation` corpus tests offline and deterministic. A live
provider contract is optional and only needed when Decisions credentials and
endpoint access are available.
