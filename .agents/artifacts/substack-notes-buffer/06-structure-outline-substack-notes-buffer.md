---
type: structure-outline
date: "2026-11-10"
repos:
  - identifier: "satwikhebbar/kipp"
    sha: "5fa223f8a5e1aa36751cc32a0509b35b20b39c2a"
flow: prd
status: implementing
tracking: "agent-harness-il3b"
---

# Implementation outline: Substack Notes through Buffer

Implement the [approved PRD](04-prd-substack-notes-buffer.md) and [approved TDD](05-tdd-substack-notes-buffer.md) in six verifiable phases. Start with compatible shared helpers and Buffer setup, then build an immediate text-only Telegram flow before adding revisions/cards, queue placement and exact-time scheduling. [Research](03-research-substack-notes-buffer.md) establishes existing behavior; the latest PRD/TDD decisions override historical interview alternatives.

This document describes implementation sequence and validation. Beads owns task status; this is not a separate completion tracker. The author authorized implementation on 10 November 2026. Account mutations, commits, pushes and deployment remain separate actions.

## Spike evidence informs this outline

The time and durability investigations are complete: [Luxon comparison](../../../docs/research/substack-notes-time-spike.md) and [eight real-runtime recovery tests](../../../docs/research/substack-notes-durability-spike.md). Their prototypes are retained for reproduction, not production implementation. [Buffer contracts](../../../docs/research/substack-notes-buffer-contract-spike.md) now include authorized live OAuth/rotation, channel authority, immediate/queue/exact-time acceptance and both native card checks, with a separate sanitized captured corpus. All test entries were removed. All three feasibility spikes are complete; the isolated probes do not implement production modules.

## Desired End State

A configured user sends /note thoughts, reviews commentary → timing → optional attached URL → exact Note, provides feedback and explicitly approves Publish, Add to queue or Schedule. Kipp submits that exact request once through the guarded Buffer integration, confirms valid acceptance and finishes. Buffer owns subsequent publication.

The first URL in original text order becomes the sole card, including Telegram masked links. Five logical writing sessions bound drafting/clarification/revisions. Normal OAuth expiry refreshes silently; known no-create authorization failures permit explicit eligible Retry. Unresolvable submission uncertainty ends with a failure-to-confirm notice and leaves the text in Telegram for independent manual reuse.

LinkedIn remains Notion-driven and creates LinkedIn drafts. Shared Calendar time conversion gains straightforward DST validation fixes. Ideation, multi-channel execution, concurrent same-chat feedback support, publication polling and a new retention subsystem stay outside scope.

## Implementation Overview

| Phase | Testable result | Dependency |
| --- | --- | --- |
| 1 | Shared helpers and strict time conversion verified, including automated webhook and live-LLM regressions (agent-harness-j9r7) | Approved design |
| 2 | Buffer setup and rotating refresh verified (agent-harness-k80l); production provisioning remains a release prerequisite | Existing vault/setup patterns |
| 3 | Text-only /note reaches exact approval and guarded immediate Buffer acceptance | Phases 1–2 |
| 4 | Clarification, revisions and first-URL cards work without stale approval | Phase 3 |
| 5 | Buffer queue placement, exact scheduled submission and eligible rejection recovery work | Phases 1–4 |
| 6 | Durable-runtime fault cases, regression checks and release documentation establish readiness | Phases 1–5 |

Phases are code/test milestones, not invitations to deploy incomplete functionality. Real publication and production configuration changes require a later explicit release instruction.

## Phase 1: Share existing helpers and implement strict time conversion

Establish small reusable boundaries while preserving existing imports and behavior. Implement the Luxon 3.7.2 wrapper recommended by the completed time spike; the design does not select Temporal.

### Change Outline

```text
src/linkedin/prompts/resolver.ts → compatibility export
  src/writing/prompt-resolver.ts
src/linkedin/workflow.ts → compatibility exports for deadline helpers
  src/core/feedback-session.ts

src/core/time.ts
  resolveLocalDateTime → unique / nonexistent / ambiguous / invalid
  localDateAt / localTimeAt / civil-day boundaries
src/calendar/{scheduling,evaluation,recurrence,validation}.ts
  shared conversion + typed DST issues
```

Adopt only the selected Luxon dependency during implementation; leave the isolated comparison packages outside Kipp's manifest. Preserve the strict interface and promote the retained case corpus into production shared-time/Calendar tests. Measure the actual integrated Worker bundle, since the spike measured standalone comparison bundles.

A matching display round-trip alone is insufficient to identify overlaps. Require accurate unique/gap/overlap results, real date and zone validation, civil-day addition and DST-aware day bounds. Keep the application API independent of the chosen implementation.

Calendar explicit one-off and recurring starts return typed clarification issues for invalid/nonexistent/ambiguous times; inferred slot search skips non-unique starts. Identify affected recurrence dates. Preserve existing reminder, availability, duration and recurrence rules and IST outcomes. Day-query bounds must cover the real local day rather than assume 24 elapsed hours.

### Validation

#### Automated Verification

After implementing these files, run:

```sh
rtk pnpm exec vitest run src/__tests__/resolver.test.ts src/__tests__/workflow.test.ts src/__tests__/calendar-scheduling.test.ts src/__tests__/calendar-evaluation.test.ts src/__tests__/calendar-recurrence.test.ts
rtk pnpm typecheck
```

Extend the existing Calendar suites and add a focused shared-time suite where it improves coverage. Include a normal Kolkata time, invalid date/zone, New York spring gap/fall overlap, a half-hour clock change, 23/25-hour day bounds and recurring starts crossing transitions. Verify retained import paths, GitHub 404-only fallback and unchanged deadline calculations. The retained spike already executes library candidates in workerd; validate the implemented wrapper and integrated bundle as well.

#### Manual Verification

Review the implemented Luxon wrapper against the retained comparison evidence. No real Calendar events are created. Prompt examples/author voice are not evaluated in this phase.

### Phase 1 implementation evidence — 10 November 2026

The shared prompt resolver and feedback deadline helpers are implemented with compatibility exports. The strict Luxon 3.7.2 wrapper now rejects invalid civil fields, unsupported zones and numeric offsets; it reports gaps and overlaps separately. Calendar validates explicit starts before availability reads, reports affected recurring dates and preserves ordinary IST behavior. Day bounds include missing/repeated midnight and skipped following dates.

Automated verification passed: 181 unit tests across ten suites, 36 integration tests across three suites (including the production wrapper in workerd and Calendar restart regressions), full source lint, documentation checks, typecheck and whitespace checks. Scoped unit execution excludes the pre-existing .zeroshot-pilot worktree to avoid duplicate test discovery.

The integrated production dry-run measured 1,475.83 KiB raw / 328.91 KiB gzip versus 1,234.16 KiB / 276.98 KiB before these changes: an increase of 241.67 KiB raw / 51.93 KiB gzip. No binding or runtime configuration changed; no deployment or live Calendar operation occurred.

Parent code review agrees with the retained spike evidence, including the additional numeric-offset and repeated-midnight cases. This satisfies the wrapper comparison review. On 12 November the author chose automated webhook journeys instead of routine manual account regression checks. The existing LinkedIn and Calendar integration suites now additionally exercise production HTTP routes, actual local Workflows/Durable Objects and real API clients with intercepted external HTTP. LinkedIn covers revision, exact draft approval and callback redelivery; Calendar covers clarification, IST creation and DST gap/overlap rejection. The separate bounded real-LLM journeys passed: LinkedIn two calls/918 output tokens; Calendar three calls/270 output tokens. No real LinkedIn or Calendar writes were made. Full default and integration suites passed, with final verification recorded in Beads agent-harness-9tvj. Phase 1 is complete in Beads agent-harness-j9r7; Phase 2 evidence follows below.

## Phase 2: Connect Buffer and safely refresh one grant

Deliver the complete credential/setup path before introducing publication. Channel selection remains a manual configuration task.

### Change Outline

```text
/setup/buffer
  Access guard → encrypted five-minute state + PKCE → Buffer consent
/auth/buffer/callback
  cookie/state → code exchange → account/scopes → encrypted grant

Buffer token acquisition
  current token → usable
  expiring token → one serialized rotating refresh
  uncertain refresh → needs reauthorization
```

Add Buffer provider types/client operations to core/types.ts, token-vault.ts and token-vault-client.ts. Add pure OAuth transport in integrations/buffer/oauth.ts and setup/callback handling in triggers/buffer-auth.ts, using existing OAuth/access/crypto helpers. Keep other providers' storage keys and refresh behavior unchanged.

Persist credential generation and refresh claim before dispatch. Concurrent callers join a live Buffer refresh; a cold start finding an abandoned claim requires reauthorization. Store both replacement tokens before returning them, and fence late refresh responses after a newer OAuth grant. Keep Buffer coordination provider-local rather than blocking LinkedIn/Google on a Buffer network request.

Add Buffer client account/organization/channel discovery. Validate BUFFER_SUBSTACK_CHANNEL_ID against the authenticated account and Substack publishing permissions/connection status, plus paused-queue diagnostics. Setup can display channel names/IDs for manual configuration but must not show tokens or add a chooser.

Add BUFFER_CLIENT_ID/SECRET, BUFFER_REDIRECT_ORIGIN, BUFFER_SUBSTACK_CHANNEL_ID and PROMPT_NOTES_PATH to Env and config/runtime-variables.json with conditional feature requirements. Read docs/production-runtime-configuration.md again before editing configuration. index.ts gets the two guarded routes; no new cron is added.

### Validation

#### Automated Verification

Create focused Buffer auth/vault/client suites, then run:

```sh
rtk pnpm exec vitest run src/__tests__/buffer-auth.test.ts src/__tests__/buffer-vault.test.ts src/__tests__/buffer-client.test.ts src/__tests__/token-vault.test.ts src/__tests__/token-vault-client.test.ts src/__tests__/google-calendar-auth.test.ts src/__tests__/linkedin-auth.test.ts
rtk pnpm typecheck
```

Cover PKCE/cookie/state expiry and replay, fixed redirect origin, granted scopes, unknown/missing channel, cross-account identity, refresh concurrency, single-use rotation, interrupted refresh, generation fencing and existing provider compatibility. Capture network request counts to prove one refresh per live claim. Use fake token/account endpoints; never print grants.

#### Manual Verification

Review setup instructions and failure messages for clarity. Real OAuth app registration, account connection and local/production secret provisioning remain separately authorized actions, not automated test prerequisites.

### Phase 2 implementation evidence — 12 November 2026

Protected Buffer setup/callback routes now use fixed-origin PKCE, encrypted five-minute single-use state and secure cookies. Read-only discovery checks authenticated organization membership and the manually configured Substack channel, publishing permissions, disconnection and paused-queue diagnostics. Setup lists channel names/IDs when configuration is absent. Operator instructions are in [Connect Buffer](../../../docs/buffer-setup.md).

The existing encrypted vault now owns a dedicated Buffer grant path. Concurrent callers share one live refresh; a durable claim precedes dispatch, rotated tokens are stored together, and a newer authorization fences late responses. Interrupted or uncertain refresh requires reauthorization. Same-account reconnection preserves connection identity; another account changes it. Generic provider operations cannot bypass this path. Existing LinkedIn/Google keys and behavior are preserved.

Verification passed: 93 focused auth/vault/client tests; full check with lint/docs/typecheck and 937 passing tests (36 gated skips); all 90 integration tests, including automated LinkedIn/Calendar webhook journeys; 41 migration tests; whitespace check; and deploy:check with 43 registered variables. Dry-run bundle: 1,493.37 KiB raw / 332.73 KiB gzip. The next refresh after reconstructed vault state uses the persisted replacement refresh token; fault tests cover abandoned claims, failed replacement persistence and generation fencing.

Parent review confirms setup instructions and failure messages match the approved flow. Existing local client credentials were retained; the spike-verified callback origin and channel ID were added only to ignored local configuration. Production provisioning and integrated real-account consent remain later release actions. No live provider calls, publication, deployment, commit or push occurred. Beads agent-harness-k80l owns Phase 2 completion; Phase 3 is next.

## Phase 3: Publish a text-only Note from Telegram through an exact approval

Deliver the first complete functional slice using immediate text-only input. Include duplicate prevention and transport recovery from the start, rather than adding them after publication works.

### Change Outline

```text
/note thoughts
  stable Workflow invocation → prompt snapshot → draft
  commentary → immediate timing → exact Note → Publish
  retained authenticated action → exact-candidate validation
  BufferPublicationDO → create once → persist acceptance
  Telegram confirmation → finish
```

Add the Notes workflow/runner/domain schemas, Notes agent and provisional bundled writing fallback. Reuse existing provider/tool-session, usage, transcript-size and prompt helpers. The fallback must meet the agreed brevity/factual constraints, but stays provisional until the deferred editorial study.

Add NOTES_WORKFLOW and BUFFER_PUBLICATIONS bindings, exports and append-only SQLite DO migration; keep production TOML value-free. Use deterministic invocation identity with create-or-get recovery. Notes state snapshots owner, prompt/model/timezone/destination, fixed deadline, candidate version and logical session counter.

Implement exact candidate fingerprints, Notes-specific action kinds and typed event validation. Extend InteractionRouterDO with Notes-only retained event delivery, owner metadata and group invalidation. On forwarding/ack failure return a retryable webhook status; redelivery uses the same immutable authenticated event. Workflow deduplicates delivery IDs. Register callback tokens before displaying buttons; bind returned message IDs for replies.

Add Telegram client options for plain text and preview control while preserving other callers' defaults. Render the Note verbatim; chunking must be lossless and preserve surrogate pairs.

Implement the reusable Buffer create client, Substack capability mapper and per-publication guard. The guard persists dispatch intent before the single network create, saves the provider ID/result independently of the Workflow checkpoint and returns stored results on replay. Use the verified output fields (shareMode rather than input mode; nullable schedulingType and Substack metadata fragment). Classify typed acceptance, confirmed rejection, unexpected-created post and unknown. Generic mutation error names do not prove rollback; enable safe Retry only for narrow verified no-create evidence, including failures before dispatch. No hidden create retry, fuzzy matching, downstream polling or public-link requirement.

### Validation

#### Automated Verification

```sh
rtk pnpm exec vitest run src/__tests__/notes-agent.test.ts src/__tests__/notes-review.test.ts src/__tests__/notes-workflow.test.ts src/__tests__/buffer-client.test.ts src/__tests__/buffer-publication.test.ts src/__tests__/interaction-router.test.ts src/__tests__/telegram.test.ts
rtk pnpm exec vitest run --config vitest.integration.config.ts src/__integration__/notes-telegram-workflow.integration.test.ts src/__integration__/telegram-approval-routing.integration.test.ts src/__integration__/workflow-approval-to-linkedin-draft.integration.test.ts
rtk pnpm typecheck
```

Prove empty-command usage, authenticated invocation, duplicate command identity, exact review/publish separation, wrong-owner/version rejection, callback redelivery after consume/send/ack faults and exactly one create under concurrent/replayed approval. A post accepted before a lost Workflow checkpoint must be returned from guard evidence without another create.

Normal acceptance finishes without polling, even when no external link is returned. Unknown returns a failure-to-confirm notice and ends with no Retry. Tests must not claim absence of a provider post simply because the client timed out.

#### Manual Verification

Review mocked Telegram messages for ordering and exact text, including Markdown-looking characters. No real Note is published during this phase's automated validation.

## Phase 4: Add clarification, revisions and the first embedded link

Complete the authoring interaction while retaining exact approval.

### Change Outline

```text
input text/entities → deterministic first URL → one attachment
writing result → draft OR necessary clarification
feedback → invalidate old authority → next writing session
  success → replacement candidate + fresh controls
  failure/limit → last valid candidate + fresh controls
```

Implement notes/links.ts with original-message entity offsets, text_link targets and literal parsing only on uncovered spans. Merge by textual order and attach the first valid HTTP(S) destination regardless of hostname. No link preference, selection list, extra confirmation, article fetch or output links from subsequent URLs.

Use the same normalized link metadata in invocation and feedback contracts. A prose revision preserves the attachment; explicit change/removal creates a new review. The agent may propose use-first-input-link or remove but cannot invent a destination or authorize publication.

Implement direct-reply feedback, Revise-to-request-feedback without generation and necessary intent/fact clarification. Count at most five logical writing sessions including failed dispatched sessions. Keep the original deadline. Reoffer the latest valid draft after failure/exhaustion, with stale controls rejected. Maintain shared transcript/usage bounds and the future independent ideation input boundary without implementing ideation.

### Validation

#### Automated Verification

```sh
rtk pnpm exec vitest run src/__tests__/notes-links.test.ts src/__tests__/notes-agent.test.ts src/__tests__/notes-review.test.ts src/__tests__/notes-workflow.test.ts src/__tests__/interaction-router.test.ts
rtk pnpm exec vitest run --config vitest.integration.config.ts src/__integration__/notes-telegram-workflow.integration.test.ts src/__integration__/telegram-approval-routing.integration.test.ts
```

Test visible/masked/mixed links, emoji before entity offsets, misleading labels, malformed entities, distinct queries/fragments, absent URLs and later URLs ignored. Assert card metadata is omitted for text-only input and includes only the approved first URL otherwise.

Exercise initial clarification, four follow-up writing sessions, repeated Revise taps, failed replacement, exhaustion with/without a valid candidate, original deadline expiry, attachment changes and old-button rejection. Assert non-writing interactions consume no session and final valid text remains approvable. Provider retries/runtime replay are not an exact HTTP billing cap.

#### Manual Verification

Review example conversations for text-only, linked input and revision feedback. Editorial examples/style quality remain a separate release activity.

## Phase 5: Queue or schedule Notes and recover only confirmed rejections

Add Buffer queue placement and exact-time scheduling to the proven approval/submission path. Buffer owns slot selection and execution; Kipp never waits until due time.

### Change Outline

```text
natural-language timing → now / queue / exact schedule; unclear intent → clarify
  queue → Add to queue approval → Buffer addToQueue without dueAt
  assigned slot returned → confirm queue acceptance and finish
  exact schedule → structured proposal + source receipt anchor
  shared resolver → UTC dueAt + local review label
  exact Schedule approval → immediate Buffer customScheduled request
  accepted requested schedule → confirm and finish

confirmed no-create rejection
  repair + eligible explicit Retry → new guarded attempt
unknown/accepted/created-unexpected
  never return to new-create Retry
```

Implement notes/timing.ts with explicit-zone precedence and snapshotted TIMEZONE fallback; request clarification if none exists for exact-time scheduling. Resolve relative dates against the persisted receipt anchor of that request, not current replay time. Initial omission means now; prose-only revision preserves existing timing. Explicit queue intent produces queue mode; vague/conflicting queue/exact-time requests and ambiguous/nonexistent times need clarification. Mode is a strict discriminant: queue cannot contain date/time/dueAt. No extra command flag is required.

Revalidate at approval, Retry and immediately before network dispatch. Never silently switch elapsed schedules to immediate. Map now to shareNow, queue to addToQueue without dueAt, and approved future dueAt to customScheduled, with automatic publishing and draft/approval options disabled. Queue review says next available Buffer slot with Add to queue controls; Buffer owns the configured posting schedule. Fingerprint queue intent, not an estimated timestamp. Store and display Buffer-assigned dueAt when returned; do not require polling or a new approval for that delegated slot. Queue needs no TIMEZONE merely to request placement.

Add Connect Buffer plus explicit Retry for known no-create failures, bounded by remaining review time, scheduled due time and the agreed repair wait. Preserve destination identity across same-account token replacement. Limit create attempts as specified in the TDD. A changed payload/time needs fresh review; seal the old definitively rejected guard before approving a new publication version. Unknown/accepted records cannot be superseded into a new create.

### Validation

#### Automated Verification

```sh
rtk pnpm exec vitest run src/__tests__/notes-timing.test.ts src/__tests__/notes-review.test.ts src/__tests__/notes-workflow.test.ts src/__tests__/buffer-client.test.ts src/__tests__/buffer-publication.test.ts src/__tests__/buffer-vault.test.ts
rtk pnpm exec vitest run --config vitest.integration.config.ts src/__integration__/notes-telegram-workflow.integration.test.ts src/__integration__/calendar-telegram-workflow.integration.test.ts
```

Test default immediate, explicit queue/exact schedule, revision preservation and explicit mode changes, vague/conflicting timing, queue-plus-dueAt rejection and addToQueue request without dueAt. Verify the successful Telegram queue confirmation shows Buffer’s returned posting date/time with the known display timezone, falls back to explicitly UTC without a configured zone, and still confirms success without an invented time or polling when dueAt is absent. Verify guarded replay uses the persisted assigned time with no second create. Test request receipt/replay anchoring, explicit/default/missing zones, preservation during rewrites, DST clarification, elapsed time at each boundary, exact provider dueAt and no wakeup/poll after scheduling. Verify revoked authorization, same-account repair, account/channel changes, stale/duplicate Retry, retry ceiling, payload change and superseded guard behavior.

Assert user-facing unknown failure retains visible text and offers no inspection-and-retry override. Known rejection recovery remains distinct.

#### Manual Verification

Review immediate/queue/exact-scheduled labels and repair guidance with explicit dates/zones. There is no account mutation or scheduled real Note unless later explicitly authorized.

## Phase 6: Verify restart boundaries and document release prerequisites

Prove that the integrated system retains its authority and mutation evidence under actual runtime interruption. Finish deployment contracts and operator documentation.

### Change Outline

Extend the Notes integration suite using existing Miniflare/workerd persistence/reboot patterns. Inject failures after dispatch claim, after provider acceptance before Workflow checkpoint, during result persistence, between router consume/send/ack and during rotating refresh. Verify recovered state and count external creates/refreshes. Include rejected-attempt supersession and stale-event delivery.

Update README, runtime configuration documentation, docs/architecture/architecture.yaml and affected system/modules/request-flows/data-state diagrams. Document command usage, manual channel-ID discovery, OAuth setup, prompt fallback, first-link behavior, queue placement/exact-time scheduling, bounded writing sessions and terminal uncertainty. Preserve the documented same-chat concurrency limitation.

Keep production configuration structural: add bindings/workflow and append-only migration, maintain keep_vars, and never write secrets or real values to tracked TOML. Verify new variables are registered and required provisioning is explicit. No code commit/push or production rollout is implied.

### Validation

#### Automated Verification

```sh
rtk pnpm lint
rtk pnpm run docs
rtk pnpm typecheck
rtk pnpm test:unit
rtk pnpm test:integration
rtk pnpm test:migration
rtk pnpm deploy:check
rtk git diff --check
```

Use runtime tests to establish replay behavior rather than relying only on mocked step.do. Run existing LinkedIn/Calendar/meal/router/security regressions appropriate to shared changes. If a broad command encounters unrelated zeroshot test-discovery failures, report the exact failure and validate the intended suites explicitly; do not silently claim a full pass or alter unrelated files.

deploy:check includes manifest/runtime contract validation and a Wrangler dry-run. Report actual missing provisioning/access requirements; a dry-run is not a production deployment or proof of account entitlement.

#### Manual Verification

Two later release prerequisites remain explicit:
- Study standout author Notes/examples, finalize the configurable default prompt and have the author assess representative writing for voice, brevity, audience relevance and factual fidelity.
- With explicit account-level authorization, exercise text-only immediate acceptance, queue placement, exact-time scheduled acceptance and external/Substack article card rendering through the configured dev setup. A real publish is an external side effect and is not authorized by this outline.

Buffer acceptance is Kipp's completion boundary. Manual inspection of an eventual card during release validation must not introduce ongoing application polling.

## Open Questions and Gates

| Gate | Resolution path |
| --- | --- |
| Shared time implementation | Spike recommends Luxon 3.7.2; Phase 1 implements the strict wrapper, promotes targeted cases and measures integrated bundle impact |
| Editorial prompt and output quality | Deferred author-example study (Beads agent-harness-5bp9); required before claiming editorial/release acceptance, not a prerequisite for mocked infrastructure work |
| Production setup and deployment provisioning | Development-account OAuth/rotation, channel permissions, three timing modes and both native card types are verified; integrate the production vault/guard and provision deployment values separately |

No additional product-flow questions remain. The TDD records spike findings and the Luxon recommendation; production implementation remains separate from the complete live Buffer spike. Implementation is authorized. Phase 1 has passed wrapper review and automated regression verification, including bounded live-LLM journeys with mocked account APIs. Phase 2 is verified; Phase 3 is next.

Queue mode is an approved amendment (10 November 2026) in Phase 5; it does not alter the six-phase order; implementation was subsequently authorized on 10 November 2026. The completed live Buffer spike includes addToQueue acceptance and assigned-time verification.

### Completed live fixtures support implementation

Use the [captured corpus](../../../docs/research/fixtures/buffer-live-spike-2026-11-10.json) alongside synthetic failures. It records actual request/result shapes for all three timing modes and both card types. expandedUrl may be empty while native cards render correctly. Sent/public-link responses were observed for the two immediate tests, but those fields remain optional completion evidence as designed.

Phase 6 validates the integrated production modules; the completed spike does not replace those regression/runtime/deployment checks. Editorial study remains agent-harness-5bp9. Test content cleanup and native-card confirmations are recorded in the report, and the temporary receiver/tunnel are stopped.
