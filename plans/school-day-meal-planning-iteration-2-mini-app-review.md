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

Evolve the existing `feedback_batch` into the **sole** durable record for an
explicit feedback submission. Today it is inserted only with the successful
revision it drove; iteration 2 instead inserts it atomically at HTTP
acceptance, then records its lifecycle until a revision uses it. This avoids a
second feedback ledger while retaining an audit link from the resulting plan
version back to the exact accepted batch.

- Add a forward-only migration that extends `feedback_batch`: retain its batch,
  plan, base-version, normalized-items, and creation fields, and add the
  authoritative `chat_id`, `workflow_instance_id`, and `week_end` copied from
  the active plan at acceptance; client idempotency key; `status`; a safe
  failure category; one-time failure-notification timestamp; and status
  timestamps. Use a server-generated batch ID and a unique
  `(plan_id, idempotency_key)` constraint. The store is its only database
  caller. Add separately bounded, expiring replay-fingerprint and
  review-context records to the same typed store surface. `feedback_batch`
  stores no transcript, browser/session credential, or raw provider failure
  text.
- `acceptMiniAppFeedback` authorizes through the server session, loads the
  active plan for that authorized chat, checks `plan_id`/`base_version` against
  the current version atomically, validates the discriminated target of every
  item (a plan target needs no cell; a cell target must exist in the stored
  schedule/grid), bounds item count/text length, normalizes target/item IDs on
  the server, and inserts-or-returns the same accepted `feedback_batch`.
  Persist the target kind with each normalized item and deliver it to the workflow so
  planning can distinguish whole-plan guidance from a cell-specific request.
  A stale base returns `409` with a safe current-plan summary and changes
  neither plan nor feedback state; idempotency-key reuse with different content
  is rejected.
- **`feedback_batch` state machine:** `accepted` → `delivered` → `processing`
  → `consumed`; terminal states are `stale` and `failed`. Immediately after the
  acceptance transaction, `startFeedbackBatch(batchId)` reads the batch's
  *stored* workflow pointer and calls `get(instanceId)` and `sendEvent`—never
  browser input or a fresh active-plan lookup. On success it records
  `delivered`; on a catchable `get`/`sendEvent` exception it records `failed`
  with a safe category and sends one explicit Telegram message that the
  feedback was received but could not be applied. The HTTP response reflects
  the same truthful outcome.
- `claimFeedbackBatchForWorkflow(batchId, instanceId, now)` is an atomic store
  operation at the first workflow step. It accepts only the stored instance,
  moves a `delivered` batch to `processing`, and validates the active base
  version in that same transaction; a mismatch records `stale`. Duplicate or
  delayed events see an already-claimed/terminal batch and do nothing.
- Wrap the workflow's planning, evaluator, persistence, and Telegram-status
  path in exception handling. Before reporting a catchable failure, atomically
  mark the batch `failed` (unless it is already `consumed`/`stale`) and claim a
  one-time notification marker; send the parent a safe Telegram outcome
  without provider internals. On success, the existing plan-version CAS,
  feedback-batch association, and `consumed` transition remain one promotion
  transaction. This keeps accepted feedback distinct from a persisted new
  plan and prevents duplicate events from creating duplicate revisions.
- There is intentionally **no cron or automatic retry** in this iteration. A
  process termination outside catchable code can leave a batch in `delivered`
  or `processing`; detecting/recovering that case is deferred work, not hidden
  behavior. The parent will receive an outcome for exceptions the request or
  workflow actually catches.

## 3. Implementation sequence

1. **Runtime and durable contracts**
   - Read and follow `docs/production-runtime-configuration.md` while adding
     `MINI_APP_ORIGIN` to `Env`, `config/runtime-variables.json`, local setup,
     and production Dashboard provisioning. Update `wrangler.prod.toml` only
     for structural bindings; values remain out of version control.
   - Add the append-only D1 migration and typed store/in-memory fake support
     for Mini App sessions; authoritative private-chat review contexts;
     consumed-init-data fingerprints with expiry cleanup; the evolved sole
     `feedback_batch` lifecycle and one-time failure notifications. Do not add
     a Mini App cron. Keep
     active-plan/version invariants intact while moving feedback-batch creation
     from promotion to acceptance.
2. **Authenticated Mini App boundary**
   - Add `meal-planning/mini-app-auth.ts`, `mini-app-routes.ts`, and DTO/schema
     modules. Mount the HTML shell plus session, active-plan read, and batch
     submission routes in `src/index.ts`; make the active-plan route return a
     discriminated ready-or-empty response for the current week; use explicit
     method/content-type and bounded-body checks, memory-only bearer sessions,
     `no-store` cache-control, metadata-only logs, authorization, and safe
     error handling.
   - Extend the workflow event/submission contracts with the server-owned
     `feedback_batch` ID, base version, and discriminated plan-or-cell feedback
     target. Add the immediate start handler, atomic workflow claim, and
     catchable-error status/notification handling around the existing revision
     path. Preserve the evaluator gate and CAS stale rejection.
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
  atomic workflow claim, catchable dispatch/workflow failure status and
  one-time notification, and promotion association. Assert that stale or
  unauthorized calls create no version,
  feedback batch mutation beyond allowed expiry cleanup.
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
- Cover the immediate exception paths explicitly: after committing an accepted
  batch, make `get/sendEvent` throw and assert `failed`, exactly one safe
  Telegram outcome, and no revision; make the workflow's agent/evaluator or
  persistence path throw and assert the same. Also prove that duplicate or
  delayed events cannot pass the atomic workflow claim twice, and that a
  successful path records exactly one consumed batch associated with one
  revision. Document that Worker termination outside those catchable paths has
  no automatic recovery in this iteration.
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
