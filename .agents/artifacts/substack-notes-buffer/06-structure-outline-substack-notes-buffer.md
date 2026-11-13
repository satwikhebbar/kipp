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
| 3 | Text-only /note reaches exact approval and guarded immediate Buffer acceptance (agent-harness-9qhw) | Phases 1–2 |
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

### Phase 3 implementation evidence — 12 November 2026

The immediate text-only slice now starts one deterministic Notes Workflow per Telegram chat/message, snapshots the resolved prompt/model/timezone/destination/deadline, and uses the shared bounded tool runner and step-size checks. The provisional writing fallback remains subject to the deferred editorial study. Review messages present commentary, timing and exact literal Note text in that order. Publish authority independently validates owner, chat, workflow, version, action ID, fingerprint and deadline; model output and typed approval markers cannot authorize a create. Basic Revise/feedback controls establish the foundation for Phase 4.

Notes-only router tables retain authenticated events atomically with consumption and replay the same event after resolve/forward/ack gaps. Invalidated Notes feedback cannot intercept later plain text for another workflow. Existing provider callback routes retain their legacy path. The SQLite publication guard saves dispatch intent before its one Buffer request and saves acceptance independently of the Workflow checkpoint. Concurrent or reconstructed calls return durable evidence; abandoned claims never release a new send. Incomplete evidence with a captured post ID permits one bounded lookup. Unknown or unexpected-created results are terminal without a create Retry.

Verification passed: full check with lint/docs/typecheck and 987 tests (37 gated skips); 96 integration tests; 41 migration tests; and deploy:check with the two new structural bindings and append-only v4 migration. The final dry-run bundle is 1,532.99 KiB raw / 341.59 KiB gzip. Six real-workerd Notes journeys cover exact approval, callback redelivery, revision/stale approval, terminal uncertainty and replay after a lost publication checkpoint. Fifty new unit cases cover agent bounds, action authority, routing, provider decoding and publication claims. The bounded real-LLM Notes journey passed in one call with 417 output tokens, using simulated account APIs. Its first attempt could not start the local test server under restricted permissions and made no model calls; the authorized rerun passed.

Parent inspection of mocked Telegram messages confirms commentary/timing/text order and literal Markdown-looking characters. No real Note was published, and nothing was deployed, committed or pushed. Local structural bindings were updated; production provisioning remains a release prerequisite. Beads agent-harness-9qhw owns Phase 3 completion; agent-harness-wmzd tracks Phase 4.

## Phase 4: Add clarification, revisions and the first embedded link

Complete the authoring interaction while retaining exact approval.

### Change Outline

```text
input text/entities → deterministic first URL → one attachment
writing result → draft OR necessary clarification
feedback → invalidate old authority → next writing session
  success → replacement candidate + fresh controls
  failed session → default Workflow retry with fixed input (same logical session)
  exhausted retries/limit → last valid candidate + fresh controls
```

Implement notes/links.ts with original-message entity offsets, text_link targets and literal parsing only on uncovered spans. Merge by textual order and attach the first valid HTTP(S) destination regardless of hostname. No link preference, selection list, extra confirmation, article fetch or output links from subsequent URLs.

Use the same normalized link metadata in invocation and feedback contracts. A prose revision preserves the attachment; explicit change/removal creates a new review. The agent may propose use-first-input-link or remove but cannot invent a destination or authorize publication.

Implement direct-reply feedback, Revise-to-request-feedback without generation and necessary intent/fact clarification. Count at most five logical writing sessions. Author-approved amendment, 12 November 2026: failed bounded sessions throw from their checkpoint and use default Workflow retries like LinkedIn, within the same logical session and with fixed input. Only after retries are exhausted reoffer the latest valid draft, with fresh controls; end with failure if none exists. Keep the original deadline. Maintain shared transcript/usage bounds and the future independent ideation input boundary without implementing ideation.

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

### Phase 4 verification evidence (12 November 2026)

Necessary clarification now uses a non-publishing handoff and the existing retained feedback route. Drafting and clarification share five logical sessions and the original deadline. Per the author’s subsequent review, failed bounded sessions use default Workflow retries with fixed input, without consuming another logical round; fallback runs after retry exhaustion. Revise taps do not generate; exhaustion or failed rewriting reoffers the exact last valid draft and card with fresh approval controls.

Original Telegram text/entity offsets select the first valid HTTP(S) destination, including masked links. Invocation and retained feedback carry the same normalized URL. Prose revisions preserve the card; the model-facing linkCardAction (keep/use-input/remove) can select the reply’s first URL or remove the card on explicit feedback. Review commentary identifies it, approval fingerprints it, and Buffer acceptance verifies the matching metadata. There is no article fetch or URL selection interaction.

Verification passed after review amendments: 1,002 default tests (37 gated skips), 104 integration tests including LinkedIn and Calendar regressions, and documentation/lint/type checks. The Notes runtime suite has 14 cases, including transient writing recovery without spending a review round and exhausted retries with/without a valid candidate. The expanded bounded live GPT-6 Luna journey exercised necessary clarification, drafting, a card-preserving revision and approval in three calls/237 output tokens; all account endpoints were simulated. Final production configuration/build dry-run passed (1,537.59 KiB raw / 342.83 KiB gzip). No Note was published and no deployment occurred. Beads agent-harness-wmzd records Phase 4; agent-harness-asw4 records review amendments; agent-harness-ve7n tracks Phase 5. Timing extraction and queue/scheduling support arrive together in Phase 5; Phase 4 has no interim prompt-only timing clarification workaround.

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

### Phase 5 verification evidence (12 November 2026)

The writer now returns a required structured timing proposal separately from prose: unchanged, now, queue, exact schedule or necessary timing clarification. notes/timing.ts resolves dates against the persisted initial/current source receipt and explicit/default IANA zone. It rejects missing/ambiguous zones, invalid dates, DST gaps/overlaps and elapsed schedules. Prose-only revisions preserve the resolved instant. Review uses Publish, Add to queue or Schedule for the exact approved mode; approval, Retry and the guard all revalidate future eligibility.

Queue mapping uses addToQueue with no dueAt; Buffer’s returned assigned slot is stored and displayed in the configured zone or explicit UTC. Exact scheduling uses customScheduled with the approved UTC dueAt. Acceptance validates the exact text/card/mode and, for exact schedules, instant. No delivery polling, Kipp scheduled wakeup or invented queue timestamp was added.

notes/publication.ts owns the explicit repair conversation. Definitive no-create preflight failures can offer Connect Buffer, channel/queue repair and Retry, without spending another writing session. The existing publication guard persists numbered attempts and consumed Retry delivery IDs, checks owner/fingerprint/expected attempt and repair/deadline/due-time eligibility, and permits at most three attempts. Lost/duplicate Retry responses cannot allocate another attempt. A changed payload seals the rejected guard before fresh approval. Changed accounts/channels require a new execution; unknown/accepted/unexpected-created evidence cannot reopen dispatch. Existing JSON/attempt tables are extended without a new binding or migration. Workflow interruption signals propagate instead of being checkpointed as terminal submission failures.

Validation passed: 1,032 standard tests (38 gated skips), 118 full integration tests including LinkedIn and Calendar regressions, final Notes subset 28 passing, documentation/lint/type checks, and production build dry-run (1,560.40 KiB raw / 347.90 KiB gzip). The live Luna queue journey passed clarification, drafting, card-preserving revision and queue acceptance in three calls/253 output tokens. The exact-schedule journey passed extraction, timing-preserving revision and approval in two calls/196 tokens. Its first live attempt correctly returned Etc/UTC but a test incorrectly demanded the exact UTC label; the semantic assertion was corrected, a deterministic UTC-alias regression added, then only that live journey rerun successfully. All account endpoints remained simulated. At verification time, no real Note publication, deployment, commit, push or Dolt remote sync had occurred for Phase 5; the author subsequently authorized commit and push.

Beads agent-harness-ve7n records Phase 5; agent-harness-plb3 tracks the remaining Phase 6 restart-boundary and release-readiness work. Editorial prompt study, integrated production-account walkthrough and production provisioning remain separate release gates.

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


### Phase 6 verification evidence — 12 November 2026

Completed under Beads agent-harness-plb3. Added sixteen production-runtime regression cases: twelve in notes-recovery.integration.test.ts and four in the existing Notes webhook suite. The new storage harness bundles the production BufferPublicationDO, TokenVaultDO and InteractionRouterDO; fault wrappers and inspection/control routes exist only in the test bundle. Reboots dispose the old workerd runtime and reconstruct it against isolated persisted SQLite stores. Full Workflow cases also retain the actual Workflow store and explicitly pause/resume the engine at the chosen boundary.

Verified dispatch-claim completion loss before create, rolled-back result writes after create, saved-result completion loss and normal acceptance replay, including the exact payload, one attempt and Buffer-assigned queue time. Confirmed rejected Retry authority and delivery deduplication survive reboot; wrong-owner and stale Retry cannot send, and superseded rejected guards remain sealed. Real webhook redelivery after resolve/ack loss survives restart with one create and no repeated writing. A review awaiting approval and acceptance before a lost Workflow checkpoint recover without changing the exact text/card.

Vault runtime cases establish no refresh after a stranded persisted claim, no reuse after a replacement-token write failure, shared concurrent access across RPC callers, unrelated-provider access during refresh, persisted replacement-token use on the next post-reboot exchange, and fencing of a late response by newer authorization. SQLite/Workflow persistence is real; provider APIs and credentials are synthetic. These controlled interruption cases do not claim exhaustive infrastructure-failure recovery.

Validation passed: pnpm check (1,032 tests, 38 gated skips; lint/docs/typecheck), all 134 integration tests across 11 files, 41 migration tests, and deploy:check (43 registered variables; 1,560.38 KiB raw / 347.90 KiB gzip). No new runtime variable, binding or migration is required. The existing v4 publication migration and production keep_vars contract remain unchanged. Existing LinkedIn/Calendar/meal/security/router regressions passed. No additional live-LLM run was needed because writing contracts and production code were unchanged in this phase.

README, Buffer setup/recovery/release guidance, runtime configuration and canonical architecture inventory/affected diagrams now describe the completed implementation and its unreleased status. Existing ADR-003 still governs Buffer-only refresh coordination; no new architectural decision was introduced. Editorial acceptance remains agent-harness-5bp9; provisioning and the explicitly authorized integrated account walkthrough are tracked by agent-harness-11x7. Changes remain uncommitted; no deployment, live account mutation, PR update or remote Beads sync was performed.

## Open Questions and Gates

| Gate | Resolution path |
| --- | --- |
| Shared time implementation | Spike recommends Luxon 3.7.2; Phase 1 implements the strict wrapper, promotes targeted cases and measures integrated bundle impact |
| Editorial prompt and output quality | Deferred author-example study (Beads agent-harness-5bp9); required before claiming editorial/release acceptance, not a prerequisite for mocked infrastructure work |
| Production setup and deployment provisioning | Development-account OAuth/rotation, channel permissions, three timing modes and both native card types are verified; integrate the production vault/guard and provision deployment values separately |

No additional product-flow questions remain. The TDD records spike findings and the Luxon recommendation; production implementation remains separate from the complete live Buffer spike. Implementation is authorized. All six implementation phases have passed automated verification, including bounded live-LLM journeys with mocked account APIs in Phase 5 and production-module cold-restart checks in Phase 6. Editorial acceptance and integrated account/provisioning validation remain release gates.

Queue mode is an approved amendment (10 November 2026) in Phase 5; it does not alter the six-phase order; implementation was subsequently authorized on 10 November 2026. The completed live Buffer spike includes addToQueue acceptance and assigned-time verification.

### Completed live fixtures support implementation

Use the [captured corpus](../../../docs/research/fixtures/buffer-live-spike-2026-11-10.json) alongside synthetic failures. It records actual request/result shapes for all three timing modes and both card types. expandedUrl may be empty while native cards render correctly. Sent/public-link responses were observed for the two immediate tests, but those fields remain optional completion evidence as designed.

Phase 6 validates the integrated production modules; the completed spike does not replace those regression/runtime/deployment checks. Editorial study remains agent-harness-5bp9. Test content cleanup and native-card confirmations are recorded in the report, and the temporary receiver/tunnel are stopped.
