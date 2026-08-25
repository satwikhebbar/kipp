# School-Day Meal Planning: Planning Decisions

**Status:** planning input  
**Scope:** implementation decisions that support the v1 product specification;
this document does not change product behaviour.

## Decision boundary

The product specification distinguishes generic properties with defined
semantics from custom natural-language policy. This document records how that
distinction guides implementation planning.

## Durable plan state

- Use one Cloudflare D1 database as the canonical store for structured profile,
  plan, plan-version, feedback-batch, and audit records.
- Workflows and Durable Objects coordinate planning and revision execution;
  they are not the long-term plan store.
- An active plan is versioned. Feedback identifies its base version and a stale
  submission must not overwrite a newer plan.
- The initial deployment remains single-bot. The configured Telegram bot is
  the scope for its records; do not add a separate household or account model.

See [the D1 feasibility note](research/cloudflare-d1-feasibility.md) for
current limits, pricing, and operational guardrails.

## Planning and validation loop

Use one bounded planning-agent loop. The agent proposes a structured candidate,
calls a deterministic `evaluate_meal_plan` tool, revises objective failures,
self-checks natural-language policy, then proposes the plan or asks a targeted
clarification. Do not introduce a separate review agent in v1.

The evaluator owns only rules with structured, reliable semantics: normalized
hard exclusions, vegetarian status, configured days and slots, explicit
packing/capacity fields, prior-night-prep count, declared morning-work total,
and repeat measurements. It returns typed failures and measurements, not
user-facing prose.

The planning agent owns interpretation of free-form policy. For every relevant
policy it records `satisfied`, `trade-off`, or `needs-clarification` with a
concise rationale. It must ask when a material policy cannot be interpreted
confidently or conflicts with a hard rule.

## Deferred multi-bot support

Kipp currently has one globally configured Telegram token, webhook secret, and
allowed user. Multi-bot support is deferred to
[GitHub issue #63](https://github.com/satwikhebbar/kipp/issues/63). It will
need per-bot encrypted credentials, opaque webhook routing, a propagated bot
context, and interaction routing scoped by bot ID and chat ID.

## Open feasibility work

- [#60: recipe-video discovery](https://github.com/satwikhebbar/kipp/issues/60)
- [#61: voice input](https://github.com/satwikhebbar/kipp/issues/61)
- [#62: Telegram Mini App review](https://github.com/satwikhebbar/kipp/issues/62)

The persistent-profile editing experience, detailed recipe-source ranking,
morning-capacity explanation, refrigerator-photo input, and shopping support
remain product decisions as identified in the product specification.
