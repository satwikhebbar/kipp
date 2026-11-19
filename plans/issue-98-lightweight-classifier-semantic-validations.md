# Issue #98 Plan: Use the Lightweight Classifier for Remaining Semantic Meal-Plan Validations

## Goal

Use the existing lightweight Decisions classifier to check meal-plan rules that
depend on meaning rather than reliable structured facts. Keep deterministic
evaluation authoritative for schema, catalog, inventory, schedule, and numeric
constraints. A semantic judgment that is missing, malformed, or uncertain must
not silently turn into a pass.

## Current state

- `src/meal-planning/evaluation.ts` is pure and deterministic. It owns rules
  whose inputs have structured semantics, and returns typed failures.
- `src/meal-planning/easy-buy-classifier.ts` already batches open-vocabulary
  `noul` questions through the Decisions endpoint, applies a confidence
  threshold, and returns actionable rejections plus usage.
- `src/agent/meal-planning-session.ts` calls that classifier after deterministic
  evaluation passes, memoizes results for the evaluate/propose checks, and
  merges failures back through the pure evaluator.
- The evaluation corpus explicitly leaves ingredient variety and custom-policy
  meaning (including real-world packing suitability) to planner judgment. The
  current evaluator checks policy-outcome presence and feedback references, but
  not whether the explanations are truthful or whether semantic requirements
  were actually met.

## Design

1. Keep deterministic validation first and as the hard gate. Do not route
   missing slots, exclusion tokens, declared cook limits, inventory facts,
   catalog validity, or other machine-readable constraints through a model.
2. Extend the existing classifier path with a typed semantic-validation result
   that identifies the validation rule, relevant plan evidence, and an
   actionable failure detail. Reuse one batched Decisions call per candidate;
   retain threshold-based abstention and treat missing or wrong-shaped answers
   as failures to confirm.
3. Begin with the remaining plan-level judgments that the corpus identifies
   as planner-owned: principal-ingredient variety and semantic custom-policy
   compliance, including packed-food suitability where a policy requires it.
   Evaluate feedback coverage only when a semantic policy or feedback asks for
   it; preserve the current deterministic scope and changed-cell checks.
4. Send compact, explicit evidence: candidate cells and ingredient names,
   relevant policy text/outcomes, and applicable feedback. Ask a separate
   yes/no question per rule or policy so answers can be attributed and rendered
   as typed failures. Avoid sending unrelated household or conversation data.
5. Make classifier failures fail closed for the semantic rule being checked,
   with a useful failure code/detail for the agent to repair or ask for
   clarification. Provider/transport errors continue through the existing
   tool error path; do not reinterpret an unavailable classifier as approval.
6. Keep classifier usage accounting and memoization coherent across
   `evaluate_meal_plan` and `propose_plan`. A final proposal must be checked
   against the same authoritative context and semantic verdicts as evaluation;
   changed candidate evidence must trigger a fresh classification.

## Implementation iterations

1. **Classifier contract and rule mapping.** Define typed semantic checks and
   failure representation, map the corpus-owned semantic requirements to
   explicit question builders, and add focused unit coverage for clear pass,
   clear fail, uncertain, missing, and malformed answers. Preserve existing
   easy-buy behavior and usage semantics.
2. **Session integration and end-to-end regressions.** Batch the semantic
   checks after deterministic passes, integrate their failures into the
   evaluate/propose lifecycle with safe cache keys, and cover repair/recheck,
   duplicate-call avoidance, classifier errors, and usage aggregation. Update
   the evaluation corpus documentation to distinguish deterministic checks
   from classifier-owned judgments.

## Acceptance criteria

- All deterministic validation remains pure, synchronous, and authoritative;
  the classifier does not override a deterministic failure.
- The classifier checks the agreed remaining semantic requirements with
  separate, attributable results and actionable failures.
- Uncertain, absent, malformed, or unavailable semantic judgments never count
  as a pass.
- Evaluation and final proposal use equivalent authoritative evidence, and a
  changed candidate is reclassified rather than served a stale verdict.
- Repeated evaluation/proposal of unchanged evidence does not duplicate
  Decisions requests; usage and returned cost remain correctly aggregated.
- Tests cover pass/fail/uncertain and operational error cases, existing
  easy-buy behavior, and end-to-end proposal gating.
- No runtime configuration, persistence schema, provider routing, or unrelated
  deterministic rule changes are needed.

## Validation

Run focused tests for the classifier, meal-plan evaluation, and agent session,
then `pnpm typecheck`, `pnpm lint:ci`, `pnpm docs`, and `pnpm test`. No live
provider test is required for the pure classification contract; run the
credential-gated Decisions contract only if the configured provider
credentials and endpoint access are available.

## Open review point

The issue page could not be retrieved from this lane's network-restricted
environment. This plan derives the semantic-rule boundary from the checked-in
evaluation corpus and code. During plan review, confirm whether the issue
intended a narrower subset of principal-ingredient variety, custom-policy
compliance, and semantic packing suitability; add only the explicitly intended
rules before implementation.
