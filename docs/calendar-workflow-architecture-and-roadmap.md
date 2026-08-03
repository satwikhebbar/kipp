# Kipp Calendar Workflow — Architecture and Delivery Roadmap

## Purpose and relationship to the requirements

This is the durable planning record for the Calendar workflow and the shared
agent foundations it will introduce. It captures the architectural, delivery,
testing, and rollout decisions agreed before implementation so later
milestone-level plans do not depend on conversation context.

[`calendar-workflow-spec.md`](./calendar-workflow-spec.md) remains the
normative product and behavior contract: it defines what Calendar must do for
the user. This document defines how Kipp should be evolved to deliver that
contract in deliberate, independently testable phases. When the documents
appear to disagree, the requirements specification wins for user-visible
Calendar behavior; resolve the discrepancy before implementation.

## Current state and architectural direction

Kipp currently has one LinkedIn workflow. It uses a Cloudflare Workflow to
coordinate a fixed LLM sequence (draft, critique, revise), waits for Telegram
feedback, and invokes integrations directly from its workflow code. Telegram
reply routing is tied to LinkedIn's GitHub-backed idea records. The current LLM
provider abstraction returns text only; it has no normalized native tool-call
interface.

Calendar is the second workflow. The goal is not a premature general-purpose
agent framework. Instead, Kipp will establish the smallest shared foundation
that two concrete workflows justify:

- workflow-scoped, resumable agent sessions;
- a source-controlled, typed tool registry and per-agent allowlists;
- native provider tool calls normalized behind one provider interface;
- deterministic, guarded tool execution;
- a short-lived Telegram interaction router;
- privacy-safe lifecycle logging and correlation IDs; and
- a provider-agnostic context/memory interface, with no generic memory store
  or retrieval behavior yet.

This foundation must make new workflows more composable without requiring
them to share business policy. LinkedIn and Calendar remain separate workflow
definitions, with their own prompts, tools, and deterministic rules.

## Agent runtime decisions

### Agent scope and autonomy

Agents are workflow-scoped and multi-turn. A Cloudflare Workflow owns the
durable execution state and resumes when Telegram delivers a reply or callback.
An agent session is therefore not limited to one prompt/response exchange.

Calendar is the first agent to use model-directed tools. It uses a **bounded
planning loop**: the model may interpret a request, request privacy-safe
availability, and select from validated options. It does not receive
unrestricted access to integrations or data.

For each incoming Telegram interaction, the runtime permits at most **three
model turns and four tool calls**. Exceeding either limit performs no further
mutation and returns a safe retry/failure response. Each interactive wait is
limited to the product-specified 15 minutes.

### Tools and guards

Tools live in a static, typed source-code registry. Each workflow agent is
given an explicit compile-time allowlist; configuration and runtime data cannot
add tools or expand permissions. Every tool declares input/output schemas and
privacy classification.

Calendar one-off and recurring proposals retain separate strict schemas under
one nonterminal `evaluate_calendar_candidate` tool. Zod aggregates structural
omissions and type failures; deterministic validation returns all independently
discoverable semantic issues as typed codes and safe parameters. The agent may
ask directly about natural-language ambiguity, but after evaluation it must
include every actionable issue in one concise request.

The model can request a tool, but never executes an external mutation itself.
A deterministic guard layer validates every request before execution and
validates the result before it returns to the model. Guards own:

- authentication and authorization;
- tool allowlists and input/output schemas;
- Calendar policy, availability, conflict, recurrence, and scheduling rules;
- OAuth refresh/reconnect behavior;
- idempotency, retry bounds, expiry, and write safety; and
- redaction of Calendar data and secrets.

Calendar exposes two nonterminal tools: a bounded `list_calendar_events` read
and `evaluate_calendar_candidate`. The former projects only opaque reference,
title, timing, all-day state, transparency, and truncation metadata from the
primary calendar; all richer fields remain hidden. The latter returns typed
validation/evaluation facts plus workflow-owned opaque plan and option IDs.
Neither tool mutates Calendar.

The agent terminates with either `ready_to_create { planId }` or
`needs_user_input`. `ready_to_create` is an intent handoff, not a write tool.
Only the workflow can resolve a current, single-use plan, revalidate it against
fresh policy and availability evidence, and execute the idempotent mutation.
Fixed Telegram buttons select only workflow-issued option IDs.

The provider layer will gain a normalized native tool-calling interface rather
than emulating calls with JSON embedded in model text. Provider adapters remain
responsible for translating their native request and response shapes into the
shared runtime contract.

### LLM responsibility boundary

Kipp divides agent behavior across three layers. This is a design rule for
every workflow, not merely a Calendar implementation detail.

| Layer | Responsibility | Must not contain |
| --- | --- | --- |
| Prompt | Natural-language interpretation, ambiguity detection, activity classification, concise user-facing language, and selection among already validated options. | Authority, secrets, raw private integration data, or rules whose failure could create, move, expose, or duplicate a real-world item. |
| Typed tool | A narrow, schema-validated capability that supplies information needed for reasoning or accepts a structured, non-authoritative proposal. | Broad integration access, dynamic permissions, or policy decisions left to model judgment. |
| Deterministic guard or workflow scaffold | Authentication, authorization, schema validation, time and date arithmetic, policy defaults, conflict handling, idempotency, retry and expiry bounds, integration writes, redaction, and lifecycle logging. | Open-ended natural-language interpretation. |

The governing test is: if a plausible model mistake could create, move,
expose, or duplicate a real-world item, the relevant decision belongs outside
the prompt. The model may request an allowlisted tool, but a deterministic
guard remains the only authority able to approve an external mutation.

For Calendar, a prompt can interpret a request such as “call Amit next Tuesday
evening,” inspect a narrowly projected event list when useful, submit a typed
candidate for deterministic evaluation, and explain the resulting facts. The
workflow scaffold enforces bounded turns and calls, authorizes opaque IDs,
revalidates fresh state, applies event policy, and performs the write. It never
places rich Calendar data or credentials in model context.

### Session routing and persistence

Cloudflare Workflows retain agent state and pending request details. A new
short-lived interaction-router Durable Object is the shared Telegram routing
layer. It records only:

- the Telegram chat and bot-message or opaque callback identifier;
- the target workflow instance;
- the expected interaction type and current action version; and
- an expiry timestamp.

It intentionally does not store Calendar request payloads, OAuth credentials,
or long-term preferences. This is not a second persisted reconnect-request
store: a 15-minute Calendar request remains in its Workflow state. The router
replaces the LinkedIn-specific GitHub reply-routing dependency while preserving
LinkedIn behavior.

Router entries expire logically at resolution time. Milestone 1 also performs
bounded physical cleanup of expired entries and old consumed entries during
ordinary router registration and resolution, rather than adding a separate
scheduled cleanup service.

### Context, memory, and observability

The runtime accepts named context providers so a later generic Kipp memory
initiative can supply reusable preferences. Phase 1 provides only the
interface. It neither persists inferred facts nor changes Calendar behavior
using memory.

Structured logs record opaque workflow/session/tool correlation IDs, outcome,
duration, and bounded retry information. They must redact raw user requests,
Calendar content, OAuth tokens, and other secrets. Dashboards, alerts, and a
generic memory implementation are deferred.

## Delivery roadmap

Each milestone is a deployment breakpoint. Detailed implementation planning is
done immediately before the milestone begins, using this document and the
requirements specification as its source of truth. A later milestone may
refine internal details based on validated evidence, but may not change an
approved product behavior without an explicit requirements update.

### Phase 1 — Shared workflow foundation and LinkedIn parity

Build the shared session, tool, guard, provider, context, interaction-router,
and observability contracts. Add the Durable Object migration required for the
router. Migrate LinkedIn to the shared session and Telegram-routing foundation,
but retain its current fixed draft → critique → revise LLM orchestration.

This phase is a strict user-facing parity migration. Preserve LinkedIn
commands, approvals, revision behavior, statuses, Telegram messages,
publishing behavior, privacy controls, and failure handling. Because LLM text
is inherently variable, regression contracts verify lifecycle and safety
behavior rather than byte-for-byte generated drafts.

**Exit criteria:** existing unit and integration coverage passes; new routing,
expiry, guard, and provider-contract tests pass; and a dev-bot LinkedIn smoke
test confirms no visible behavior regression.

### Phase 2 — Calendar core: safe simple one-offs

Add Google Cloud OAuth setup, encrypted provider-namespaced Calendar tokens,
primary-calendar access, and shared `TIMEZONE` configuration with
`Asia/Kolkata` as the initial value. Add the explicit `/calendar <request>`
Telegram entry point and Calendar's bounded, native-tool-enabled planning loop.

Ship clear, conflict-free personal one-off blocks with validated defaults,
availability-only reads, inferred-time same-day shifting, required private
`kipp.*` event metadata, private/busy event settings, and reminder overrides.
Use deterministic opaque event IDs from the first Calendar write so Telegram
webhook redelivery cannot duplicate an event.

This is intentionally safe but minimal: explicit-time conflicts and
unavailable/expired authorization return safe guidance. Immediate Edit and the
reconnect + Retry experience arrive in Phase 3.

**Exit criteria:** automated OAuth, scheduling-policy, availability, metadata,
and no-duplicate-write tests pass; a dev bot creates and verifies a clearly
labeled short-lived test event on the connected primary calendar.

### Phase 3 — Complete the one-off Calendar experience

Complete the agreed one-off interaction contract: date/time clarification,
duration/reminder/description defaults, privacy-safe explicit-conflict choices,
the 15-minute Edit and reconfirmation loop, and all constraint and expiry
rules. Add the retained-request reconnect + Retry flow: reconnect starts fresh
OAuth, Retry is user initiated, makes one attempt, and expires after 15
minutes.

This phase completes the user-facing one-off behavior defined in the
requirements specification. Recurrence remains excluded.

**Exit criteria:** integration coverage exercises every one-off decision
branch, including edit, conflict, expiry, authentication recovery, and
reconnect; controlled dev-bot validation covers the same high-risk paths.

### Phase 4 — LinkedIn native tool-loop adoption

After Calendar has validated the tool contracts in production, move LinkedIn
from its fixed orchestration to the shared native-tool runtime. Retain the
Phase 1 lifecycle and safety contract while allowing its model to use only its
workflow-specific allowlisted tools.

Human approval remains an external deterministic guard. A model must never be
able to publish merely by deciding to invoke a publishing tool.

**Exit criteria:** the LinkedIn integration suite covers native tool requests,
guard denials, approval-gated publication, revisions, and error paths; a dev
bot smoke test confirms the established user journey.

### Phase 5 — Recurring Calendar blocks

Implement the supported recurrence forms and all recurrence behavior in the
requirements specification: an explicit first occurrence, a hard six-calendar-
month horizon, weekly named-weekday scope, month-end rules, all-occurrence
validation, whole-series immediate Edit, and the 50% conflict heuristic for
single-series-time versus per-date-adjustment proposals. Use a separate
recurring proposal handoff with explicit presence states. Use `rrule` behind a
narrow adapter for bounded recurrence expansion and RRULE serialization; it
passed TypeScript and Wrangler Worker bundling. Keep rule-set validation,
month-end semantics, availability policy, and Calendar authorization in
Kipp-owned deterministic guards.

**Exit criteria:** recurrence and exception test matrices cover each supported
cadence and conflict outcome; a controlled dev-bot smoke test creates,
inspects, and removes a temporary series.

### Phase 6 — Calendar v1 hardening and handoff

Complete the remaining operational reliability work: bounded transient retry
coverage, confirmation-only recovery after a successful Calendar write,
duplicate-delivery tests, failure-path observability, and exhaustive decision
branch tests. Document Google Cloud setup, token reconnection, shared
configuration, local dev-bot validation, and operational troubleshooting.

Update architecture documentation where the interaction router, new Workflow
bindings, or Google integration alter the deployed system.

**Exit criteria:** full project checks pass, controlled end-to-end smoke
coverage passes, and documentation is sufficient to configure and deploy the
workflow without relying on this conversation.

## Release and validation policy

Every completed usable slice may be deployed. Kipp has one Telegram user and
Calendar requires an explicit `/calendar` command, so no separate Calendar
feature flag or staged-user allowlist is needed.

Before a Calendar deployment, run the full automated check suite and validate
the deployed slice using the existing separate dev bot. Live validation uses a
clearly labeled, short-lived test event in the connected primary calendar;
inspect it and remove it after testing. Do not use the production bot as the
smoke-test route.

## Explicit deferrals

- Generic Kipp memory design, storage, review, correction, and forgetting.
- Calendar ETag protection for manual Calendar edits during the immediate Edit
  window.
- Runtime-configurable tools, dynamic permissions, dashboards, alerts, and a
  broad autonomous-agent loop.
- Any Calendar v1 behavior excluded in the requirements specification.

## Planning protocol for later phases

Before implementing a phase, create a phase-specific plan that names the
interfaces, state changes, migrations, test cases, deployment prerequisites,
and acceptance checks needed for that phase. It must preserve the decisions in
this document and the Calendar requirements specification. New uncertainty or
a proposed behavior change returns to requirements/design discussion before
code changes begin.
