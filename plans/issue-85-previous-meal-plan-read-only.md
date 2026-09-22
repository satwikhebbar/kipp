# Issue #85 — Keep the previous meal plan read-only until the next plan is generated

## Goal

Keep the most recently persisted plan visible while a new `/mealplan` workflow
is clarifying, generating, enriching, or failing. During that interval the old
plan is a read-only snapshot: it can be inspected, but it cannot receive Mini
App feedback or start a Telegram revision. Once a new plan is committed, the
new plan becomes the only writable current plan and the old plan remains
available through an explicit historical/read-only selector.

The change preserves the existing atomic `createActivePlan` replacement,
version CAS, stale-button checks, and server-owned Mini App authorization. It
does not create a second canonical plan store or allow a browser to choose a
chat, workflow, or write target.

## Current behavior and constraints

- `src/meal-planning/mini-app-routes.ts` calls `activePlan(chatId)` and returns
  `empty` when the plan ID does not match the session or `weekEnd` has passed.
  This hides an otherwise valid persisted plan on Sunday/next-week resolution.
- `meal_plan` has one `active` row per chat; `createActivePlan` atomically marks
  the old row `replaced` only in the same transaction that inserts the new plan
  and version. Failed generation therefore already leaves the old row intact.
- `acceptFeedbackBatch`, revision promotion, and the Telegram live loop use
  `status = 'active'`, current version, instance ID, and/or generation CAS
  guards. Those guards must remain authoritative for writes.
- The Mini App session is opaque and chat-scoped through the durable review
  context. Plan history must be resolved by that server-side chat scope, never
  by trusting a client-supplied user/chat/workflow identifier.
- The existing Mini App shell renders mutation controls for every `ready` plan;
  the read model must explicitly tell it when to hide those controls.

## Proposed design

### 1. Add a durable, expiring generation lease

Add a forward-only migration for a chat-scoped generation record (prefer a
separate `meal_plan_generation` table rather than overloading `meal_profile`):

```text
chat_id             PRIMARY KEY
generation_id       opaque workflow-generation token
status              generating | failed
started_at          ISO timestamp
expires_at          ISO timestamp
updated_at          ISO timestamp
```

Use a closed status check and an expiry index. `startPlanGeneration` inserts or
replaces the lease for the chat and returns its token. `finishPlanGeneration`
clears only the matching token, so an older/replayed workflow cannot clear a
newer planning session. Reads treat an expired lease as inactive and clean it
up opportunistically. Keep the lease TTL longer than the normal workflow
deadline, and refresh it at durable workflow boundaries if needed; a crashed
workflow therefore cannot strand the old plan indefinitely.

Extend both D1 and in-memory store implementations and their shared types. The
generation methods are state-management operations only; they do not alter
`meal_plan` rows or versions.

### 2. Scope the workflow lease around initial-plan generation

In `src/meal-planning/agent-workflow.ts`, acquire the lease before reading the
recent plan or beginning week-context extraction. Keep the existing plan in
place while clarification, model calls, video enrichment, and persistence are
running. Finish the matching lease in all terminal paths:

- successful `createActivePlan` commit: clear the lease after the new plan is
  durably persisted (the new plan is then writable/current);
- no proposal, clarification abandonment, or caught generation failure: clear
  the lease and leave the previous plan active/current;
- unexpected failures: clear in a `finally`/terminal step where the Workflow
  execution model permits, with expiry as the recovery backstop.

Do not mark the old plan `replaced` at generation start. Keep the existing
atomic replacement inside `createActivePlan`; this is the transaction boundary
that defines successful generation.

While a lease is active, prevent new feedback submissions against the prior
active plan. The guard belongs in the store's atomic acceptance path (and the
in-memory equivalent), not only in the UI. Return a distinct `generating`
conflict reason so the HTTP route can explain that the current plan is being
replaced without exposing workflow details. Existing Telegram interactions
should also re-check the lease before opening a feedback prompt or accepting a
plain-text submission, while stale/foreign interaction checks remain first.

### 3. Add a history read model without changing write ownership

Extend `MealPlanningStore` with read-only operations that hydrate a plan and
its current immutable version by authorized chat scope:

- `listPlanHistory(chatId)` — current active plan plus replaced plans, ordered
  newest first, with a bounded retention/window appropriate for the existing
  D1 data volume;
- `planById(chatId, planId)` — returns only a row belonging to that chat.

The queries must join the selected plan to its `current_version`; they must
never return a partial version or workflow-only fields to the client. Keep
`activePlan` unchanged for workflow writes and current-plan operations.

Change the Mini App read contract to a discriminated, client-safe response:

```text
status: "empty"
status: "generating", currentPlan: ReadOnlyPlan, history: HistoryEntry[]
status: "current", plan: PlanDto, history: HistoryEntry[]
status: "historical", plan: ReadOnlyPlan, history: HistoryEntry[]
```

`current` is the active plan outside a generation lease. `generating` exposes
the still-active prior plan as read-only (if one exists) and identifies that a
new plan is in progress. `historical` is returned only when the selected plan
is `replaced`; it is read-only even if the request arrives through an old
review link. `empty` is reserved for a chat with no persisted plan and no
generation lease. Each history entry includes only plan ID, week bounds,
version, lifecycle (`current`/`historical`), and whether it is writable.

Use a server-selected default plan from the authenticated session/review
context, and accept a plan selector only after loading it by `session.chatId`.
The selector must not change the session's chat, user, workflow instance, or
write authority. A bounded history list prevents this endpoint from becoming
an unbounded data export.

### 4. Make the Mini App presentation and write boundary explicit

In `src/meal-planning/mini-app-routes.ts`:

- remove the date-based `weekEnd` rejection from reads;
- return the discriminated current/generating/historical/empty DTO above;
- include a `readOnly` flag in the plan DTO and do not include workflow
  instance IDs, session credentials, or provider data;
- make `POST /mini-app/api/feedback` reject any `readOnly`/replaced selection,
  any non-current version, and any active generation lease in one store-side
  authorization/acceptance check. Preserve `409` for stale or generating
  conflicts and idempotency behavior for accepted current-plan batches.

In `src/meal-planning/mini-app/client.ts`, render the same persisted board for
current, generating, and historical plans but make state visible:

- current: show the existing Change/feedback controls;
- generating: label the previous plan as “read-only while your next plan is
  being generated”, hide Change, drafts, and submit controls, and offer a
  refresh/retry affordance;
- historical: label the week/version as historical/read-only, hide all write
  controls, and provide the history selector;
- empty: retain the existing no-plan recovery message.

When a new current plan is selected, clear local drafts for another plan/version
and reload the writable state. A `409` remains a recoverable refresh state, and
the client must never re-enable controls based solely on cached state.

### 5. Keep Telegram and stale-button behavior safe

Update the Telegram live-loop and text fallthrough checks so a generation lease
causes old-plan feedback intent to receive a stable “new plan is being
generated; please wait” outcome. Do not mutate or cancel the old plan. A
stale callback/version/generation mismatch still wins before this message.

After `createActivePlan` succeeds, the existing interaction-generation bump,
new review context, new message buttons, and old-plan replacement notice stay
in the same order. The old plan's existing callback and Mini App sessions must
become read-only through server state; no client-side button removal is relied
upon for safety.

## Files expected to change during implementation

- `migrations/0003_*_meal_plan_generation.sql` (or the next migration number):
  generation lease table/index and closed enum checks.
- `src/meal-planning/store.ts`: generation lease types/methods, history reads,
  atomic feedback guard, D1 and in-memory parity.
- `src/meal-planning/agent-workflow.ts`: lease lifecycle around initial-plan
  generation and terminal cleanup.
- `src/meal-planning/mini-app-routes.ts`: date-independent history read DTO,
  selected-plan authorization, and read-only/generating feedback rejection.
- `src/meal-planning/mini-app/client.ts`: state labels, history selector, and
  mutation-control suppression for non-writable plans.
- Telegram meal-planning routing/workflow files as needed for generation-state
  feedback rejection; retain stale checks and existing messages where possible.
- `src/__tests__/meal-planning-store.test.ts`: generation lease lifecycle,
  expiry/token safety, history hydration, replacement, and atomic feedback
  rejection in both D1 and in-memory stores.
- `src/__tests__/mini-app-routes.test.ts` and related Mini App tests: Sunday/
  next-week reads, generating state, history selection, read-only write
  rejection, stale session/version behavior, and successful replacement.
- workflow/integration tests covering failed/abandoned generation, successful
  persistence, old Telegram buttons, and no accidental revision against an
  old plan.

No runtime variable, Worker binding, cron, or Durable Object change is
expected. If implementation discovers one is necessary, stop and apply the
production-runtime configuration guidance before editing it.

## Test and validation plan

1. Run focused store, Mini App route/auth, and meal-planning workflow tests.
2. Add assertions for both D1 and in-memory store behavior so the test double
   cannot accept writes that production rejects.
3. Run `pnpm lint`, `pnpm run docs`, `pnpm typecheck`, and `pnpm test`.
4. Manually inspect the generated DTO/UI states for current, generating,
   historical, and empty plans; verify no historical response contains a
   feedback affordance or workflow/session secret.

## Acceptance mapping

| Issue requirement | Design coverage |
| --- | --- |
| Previous plan survives Sunday/next-week resolution | Date-independent history reads; old active row remains until atomic replacement |
| Failure, abandonment, or in-progress generation leaves it visible | Expiring generation lease; no early replacement; `generating` DTO |
| Post-replacement history is intentional | Bounded chat-scoped history and explicit historical selector |
| Old plans cannot mutate | Read-only DTO plus store-side status/version/lease guards on feedback and Telegram paths |
| Stale/version safety | Existing CAS and interaction-generation checks retained and tested first |
| Clear no-plan/generating/current/historical states | Discriminated API contract and matching Mini App labels/controls |

