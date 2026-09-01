# School-Day Meal Planning — Iteration 2: Mini App Review and Feedback

> **Status:** plan for GitHub issue #66 (parent: #59; follows the merged
> Telegram-first workflow in #65 and the Mini App spike in #62)
>
> **Decision:** use the existing bot and a same-origin Telegram Mini App as the
> phone-optimized review surface. Telegram remains the only conversation,
> clarification, progress, and new-plan-notification surface. The Mini App
> never runs the planner and never treats device storage as canonical state.

## 1. Goal and boundary

An authorized parent can open the persisted active meal-plan version from a
contextual Telegram **Review this week's plan** Web App button, scan it on a
phone, collect several local drafts against either an individual day/meal cell
or the plan as a whole, and explicitly hand one version-bound batch to the
live MealPlanningWorkflow. The app acknowledges acceptance and returns the
parent to Telegram; it does not imply that a new plan has already been created.

This iteration layers the review UI and authenticated HTTP boundary over the
existing versioned D1 plan/workflow contracts. It does not change the
evaluator, planning semantics, profile editing, multi-bot model, or the
Telegram-first clarification loop. Existing **Give feedback** reply flow stays
as a conversational fallback.

## 2. Design decisions

### 2.1 Launch, authority, and session

- Add a `MINI_APP_ORIGIN` text runtime variable. It is the configured public
  HTTPS origin used only to construct the inline Web App URL; the URL contains
  no plan, chat, user, or version identifier.
- Add a contextual `web_app` button alongside the existing feedback callback
  when `sendPlanAndRegister` sends a **persisted** plan message. The button
  appears only after `createActivePlan` or `promotePlanVersion` succeeds, so a
  review link always represents an immutable persisted version. Keep the
  callback registration/button as the text fallback.
- Serve the Mini App shell at a same-origin route and expose same-origin JSON
  endpoints. The shell may be visible in a normal browser but must disclose
  that authentication is required and must never embed plan data.
- When a persisted plan message receives its Web App button, create or refresh
  a durable, server-owned review-context mapping for its intended verified
  Telegram user, originating **private** `chat_id`, plan, and week. A valid
  Mini App launch resolves its chat only through this mapping; it must not
  infer a reply destination from `initData`'s optional chat fields or equate a
  user ID with a chat ID. The current single-parent configuration can populate
  this mapping from the configured parent and plan chat; future household or
  group support requires its own explicit server-side membership mapping.
- On every new WebView session, the client POSTs only raw
  `Telegram.WebApp.initData`. Server code reconstructs Telegram's sorted
  data-check string and verifies its two-stage HMAC using `TELEGRAM_BOT_TOKEN`,
  then rejects malformed values, missing user data, a timestamp more than ten
  minutes old or more than one minute in the future, and constant-time
  mismatches. It hashes the raw launch value, atomically records that
  fingerprint with a bounded expiry, and rejects re-use before authorizing the
  verified user against `TELEGRAM_ALLOWED_USER_ID`.
- After verification, create a short-lived opaque server session backed by the
  meal-planning durable store. Session records bind the verified user and the
  resolved review-context chat scope; reads/writes derive authority solely
  from that record. Keep the returned session token only in page memory, send
  it in an `Authorization` header over same-origin HTTPS, and never put it in
  a URL, DeviceStorage, or logs. Do not trust `initDataUnsafe`, bearer-client
  claims, query parameters, or client-supplied plan/chat/user IDs. Set
  `Cache-Control: no-store` on the shell and all Mini App API responses, and
  log only security/outcome metadata—never raw `initData`, session tokens, or
  feedback text.

### 2.2 Read model and mobile UI

- Add a Mini-App DTO adapter over `ActivePlanRecord`; it maps the persisted
  schedule, plan header, current version, candidate grid, policy/trade-off
  cues, preparation state, optional recipe-video metadata, and active-week
  labels into a client-safe response. It exposes no workflow instance ID,
  interaction tokens, raw provider material, or unrelated D1 rows.
- Make the authenticated active-plan read a discriminated response: return a
  client-safe `ready` DTO only when the authorized chat has an active plan for
  the current planning week; otherwise return a data-free `empty` response
  with the current week label. An absent plan is an expected state, not a
  not-found error and not permission to create a synthetic blank plan.
- Render a compact Monday–Saturday, phone-first board using Telegram theme,
  safe-area, viewport, main-button/back-button, and closing-confirmation APIs.
  Each meal cell has a glanceable dish/state summary; a sheet/detail view
  exposes ingredients, prior-night prep, cook time, substitutions/easy buys,
  policy/trade-off context, and opt-in external recipe links. Escape all
  server-provided text before insertion; build DOM nodes rather than injecting
  dynamic HTML.
- Visibly separate three states: the persisted active version (including its
  version/week), unsent **Feedback ready** drafts, and a submitted
  **Feedback sent — continue in Telegram** handoff. For expired sessions,
  unavailable plans, and version conflict, show recoverable messages without
  exposing data.
- Support two explicit draft targets in the ready state: a cell target for a
  particular stored day/meal slot, and a plan target for feedback about the
  week's plan as a whole (for example, “too many new dishes”). Keep the chosen
  target visible in the draft summary and send both kinds only in the same
  deliberate batch; neither kind directly edits a cell or changes the plan.
- For the `empty` response, show a first-use/missed-week empty state: explain
  that no plan exists for this week and direct the parent back to Telegram to
  send `/mealplan` (using a Telegram deep link where it is supported, with a
  visible copyable command fallback). Do not show the meal board, feedback
  drafts, or submit action. This covers a first Mini App launch, an old review
  button, and a Monday launch before the parent creates that week's plan.

### 2.3 Local drafts

- Keep drafts only in Telegram DeviceStorage (with a browser-storage fallback
  solely for local developer usability), keyed by the server-returned plan ID
  and exact current version. A draft contains either
  `{ target: { kind: "cell", day, slot }, text }` or
  `{ target: { kind: "plan" }, text }`, and is never sent until the explicit
  batch action.
- Restore only that key, label restored drafts, and discard the key when the
  parent submits, explicitly discards, receives a newer version/conflict, or
  opens a different plan/version. Explain in the UI that drafts are local to
  this device and are not canonical or cross-device.

### 2.4 Durable batch acceptance and workflow handoff

The existing `feedback_batch` row is an immutable record created with a
successfully persisted revision. It cannot alone make an HTTP submission
idempotent, because it does not exist while a revision is awaiting a model turn
or clarification. Add a separate D1 submission ledger for the Mini App.

- Add a forward-only migration with a `meal_feedback_submission` table:
  server-generated submission ID; the authoritative `chat_id`, `plan_id`,
  `workflow_instance_id`, and `week_end` copied from the active plan at
  acceptance; `base_version`; normalized scoped `items_json`; client
  idempotency key; dispatch/processing lease fields; a monotonic
  `processing_claim_generation` fencing value; attempt count and next attempt;
  terminal reason; status timestamps; and a unique
  `(plan_id, idempotency_key)` constraint. The store is its only database
  caller. Add a separately bounded, expiring replay-fingerprint record and a
  review-context mapping to the same typed store surface. The ledger stores no
  transcript, browser/session credential, or raw provider failure text.
- `acceptMiniAppFeedback` authorizes through the server session, loads the
  active plan for that authorized chat, checks `plan_id`/`base_version` against
  the current version atomically, validates the discriminated target of every
  item (a plan target needs no cell; a cell target must exist in the stored
  schedule/grid), bounds item count/text length, normalizes target/item IDs on
  the server, and inserts-or-returns the same immutable submission. Persist
  the target kind with each normalized item and deliver it to the workflow so
  planning can distinguish whole-plan guidance from a cell-specific request.
  A stale base returns `409` with a safe current-plan summary and changes
  neither plan nor feedback state; idempotency-key reuse with different content
  is rejected.
- **Dispatch state machine:** `pending` → `dispatching` → `delivered` →
  `processing` → `consumed`; terminal states are `stale`, `expired`, and
  `failed`. `claimFeedbackDispatch(now)` atomically leases an eligible pending
  row (or a row whose delivery acknowledgement/lease expired), increments the
  attempt number, and returns its *stored* `workflow_instance_id`, submission
  ID, and expected base version. The dispatcher calls `get(instanceId)` and
  `sendEvent` only from that result—never from browser input or a fresh active
  plan lookup. A successful call sets `delivered` plus a bounded
  workflow-claim deadline. A send/get failure releases the lease back to
  `pending` with capped exponential backoff (for example 1, 5, 15, 30, then
  60 minutes) and metadata-only logging.
- Invoke the dispatcher immediately after the acceptance transaction as a
  best-effort latency optimization, and from a new five-minute Worker cron as
  the durable recovery owner. The cron scans only due/recoverable rows using
  the same atomic lease operation, so concurrent HTTP, cron, and restart
  dispatchers cannot send a row concurrently. It marks a row `expired` rather
  than signalling it when its stored `week_end` has passed; after a bounded
  attempt/deadline budget it marks `failed`. Both terminal paths claim a
  one-time notification marker and send an explicit Telegram outcome (plan
  ended, stale/newer version, or feedback accepted but not applied), leaving
  the active persisted plan unchanged.
- `claimMiniAppSubmissionForWorkflow(submissionId, instanceId, now)` is an
  atomic store operation at the first workflow step. It accepts only the
  stored instance, moves a `delivered` row to `processing`, increments and
  returns `processing_claim_generation`, and grants a lease long enough for
  the bounded agent plus its clarification wait. It validates the active base
  version in that same claim transaction; a mismatch records `stale` with the
  minted generation. Duplicate/delayed events observe `processing`/`consumed`
  and are ignored.
- Treat the returned generation as a fencing token. The workflow carries it in
  its in-memory/durable event state and calls `renewMiniAppSubmissionClaim`
  before every durable step that can start agent/video work and immediately
  before any plan persistence or Telegram status action. Renewal requires
  `status = processing`, the exact generation, and an unexpired lease. The
  processing lease exceeds the maximum bounded agent and clarification window;
  this makes an active session renewable rather than recoverable. A failed
  renew means ownership is lost: that execution stops without further planning,
  persistence, or user notification.
- The cron returns only a genuinely expired `processing` lease to `pending`;
  the next delivery receives a newly incremented claim generation. Every
  workflow-owned terminal transition (`stale`, no-change, abandoned, evaluator
  failure, and retryable/failed processing), terminal-notification claim, and
  processing-lease renewal is conditional on that exact generation. The
  promotion transaction additionally requires `processing`, matching
  generation, and unexpired lease while it performs the plan-version CAS,
  feedback-batch association, and `consumed` transition. A preempted worker
  can therefore neither promote nor emit a duplicate status after a reclaim;
  only the new generation may do so.
- This keeps accepted feedback distinct from a persisted new plan and provides
  eventual delivery without duplicate revisions. It also fences a workflow
  that resumes after a transient pause: its first renewal fails before it
  initiates more work, while the recovery event owns the next generation.

## 3. Implementation sequence

1. **Runtime and durable contracts**
   - Read and follow `docs/production-runtime-configuration.md` while adding
     `MINI_APP_ORIGIN` to `Env`, `config/runtime-variables.json`, local setup,
     and production Dashboard provisioning. Update `wrangler.prod.toml` only
     for structural bindings; values remain out of version control.
   - Add the append-only D1 migration and typed store/in-memory fake support
     for Mini App sessions; authoritative private-chat review contexts;
     consumed-init-data fingerprints with expiry cleanup; the submission
     ledger; atomic dispatch/processing leases; claim-generation fencing; and
     terminal notifications.
     Add the five-minute recovery cron to `wrangler.prod.toml` and its handler
     to `src/index.ts`; retain the existing cron entries. Keep
     active-plan/version and existing feedback-batch invariants intact.
2. **Authenticated Mini App boundary**
   - Add `meal-planning/mini-app-auth.ts`, `mini-app-routes.ts`, and DTO/schema
     modules. Mount the HTML shell plus session, active-plan read, and batch
     submission routes in `src/index.ts`; make the active-plan route return a
     discriminated ready-or-empty response for the current week; use explicit
     method/content-type and bounded-body checks, memory-only bearer sessions,
     `no-store` cache-control, metadata-only logs, authorization, and safe
     error handling.
   - Extend the workflow event/submission contracts with server-owned
     submission ID, base version, and discriminated plan-or-cell feedback
     target. Add the immediate dispatcher plus cron recovery handler, and
     claim/renew/complete the fenced ledger through store operations
     before/during/after the existing revision path. Require the claim
     generation in promotion and all workflow-owned notifications while
     preserving the evaluator gate and CAS stale rejection.
3. **Telegram launch integration**
   - Extend the Telegram plan keyboard to include the contextual Web App URL
     only when `MINI_APP_ORIGIN` is configured, keeping the review action on
     initial and revised persisted messages. At that same post-persistence
     point, write the server-side private-chat review context. Keep the current
     callback-based feedback route operational.
4. **Client**
   - Add a deliberately small dependency-free Mini App page/script/style under
     `src/meal-planning/mini-app/`. Authenticate, fetch the DTO, render the
     board/details or the no-plan `/mealplan` empty state accessibly, manage
     version-keyed DeviceStorage drafts only for ready plans, and submit one
     explicit idempotency-keyed batch. After a 202 acceptance, clear
     drafts, show handoff confirmation, and call `WebApp.close`; a 409 clears
     stale drafts and requires loading the newer review link.
5. **Documentation and release readiness**
   - Update the meal-planning architecture/module documentation and runtime
     contract. Document local/prod Mini App HTTPS configuration, device-local
     draft retention, and the Android/iOS Telegram verification checklist.

## 4. Test plan and acceptance evidence

- Unit-test raw `initData` verification: Telegram's canonical sorted
  data-check HMAC; valid signed data; tampered hash; malformed/missing user;
  expired/future timestamps; replay fingerprint expiry and atomic reuse;
  unauthorized verified user; session expiry; and constant-time comparison
  helper behavior. Assert no raw launch value, token, or feedback text reaches
  logs.
- Store tests cover plan-scoped session authorization and review-context
  resolution (including a verified user that must not read another chat);
  valid plan-level target acceptance; exact schedule/grid validation for a
  cell target; rejection of malformed or nonexistent targets; identical retry,
  idempotency-key payload mismatch, stale version, cross-chat isolation,
  delivery leases/backoff,
  workflow claim/renewal/fencing, terminal notification claim, and promotion
  association. Assert that stale or unauthorized calls create no version,
  feedback batch, or submission mutation beyond allowed expiry cleanup.
- Worker-route tests cover unauthenticated plan/batch requests, valid session
  creation, memory-only token transport, no data in the ordinary browser shell,
  `no-store` cache/security headers,
  safe DTO shape, 202 acceptance, 409 conflict response, and safe response to
  an expired session. Verify the authorized no-active-plan response is a safe
  `empty` state for the current week, never a synthetic plan or an error that
  leaks state.
- Workflow/integration tests drive `/mealplan` through the review keyboard,
  authenticated Mini App submission, duplicate HTTP delivery, stale submission,
  clarification, and successful revision. Assert that Telegram reports
  progress, the active plan remains version N until the workflow persists N+1,
  and only the post-persist N+1 message carries its fresh review link.
- Cover the post-commit delivery failure window explicitly: commit an accepted
  ledger row, make `get/sendEvent` fail, restart the dispatcher and run the
  cron recovery, then prove exactly one workflow claim and revision (one
  `feedback_batch`) or one truthful terminal Telegram outcome when the
  instance remains unavailable or the week expires. Also prove that a delayed
  first event plus the recovery event cannot pass the workflow claim twice.
- Simulate a first workflow pausing until its processing lease is reclaimed,
  then resuming after the recovery workflow receives the next claim generation.
  Assert that the old generation cannot renew, invoke more planning work,
  promote, consume the submission, or claim/send a Telegram status; only the
  current token can produce the one revision/`feedback_batch` or truthful
  terminal outcome.
- Client-focused tests verify week rendering, detail disclosure, creation and
  clear/restoration of both cell- and plan-level drafts, their visible target
  summaries, the first-use and missed-Monday no-plan state with its `/mealplan`
  handback and no feedback controls, explicit batch state, conflict UI, and no
  client-controlled identity, plan selector, or forged feedback target.
  Manually verify the
  production-like HTTPS flow in Telegram on Android and iOS, both themes,
  keyboard open/close, safe-area/viewport changes, and close/reopen recovery.
- Run `pnpm lint`, `pnpm run docs`, `pnpm typecheck`, `pnpm test`, and
  `pnpm deploy:check` once runtime configuration is provisioned.

## 5. Done criteria

Issue #66 is complete only when an authorized configured parent can inspect a
persisted plan in the phone Mini App, or receive a safe no-plan state that
directs them to `/mealplan` in Telegram, then submit one locally drafted,
version-scoped batch containing plan-level and/or cell-level feedback exactly
once, and continue through Telegram until a new version is persisted. Every
request is authenticated and resource-authorized on the server; drafts cannot
become canonical; stale/duplicate activity cannot overwrite a newer active
version; and a review link never points to an unpersisted plan.
