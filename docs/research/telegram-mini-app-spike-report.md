# Telegram Mini App feedback spike — results and implementation handoff

**Issue:** [#62](https://github.com/satwikhebbar/kipp/issues/62)  
**Status:** completed throwaway prototype  
**Decision:** proceed with a Telegram Mini App as Kipp's visual review surface; keep the agent conversation in Telegram.

## What this spike proved

Using the existing development bot, local Kipp Worker, ngrok HTTPS tunnel, mock plan data, and one physical phone, the prototype successfully demonstrated this user journey:

1. A parent opens a contextual **Review this week's plan** button from the development bot.
2. Telegram opens a mobile Mini App with a readable six-day mock meal plan and meal-level details.
3. The parent types feedback for multiple meals. Each **Add feedback** action remains local to the Mini App; it does not send a message or request a new plan.
4. Closing and reopening the Mini App restores the unsubmitted drafts for that plan on the same Telegram device.
5. **Replan with N feedback items** sends the batch once to Kipp, displays an explicit handoff confirmation, and closes the Mini App.
6. The development bot continues in Telegram with a mock clarification question. The Mini App does not misleadingly display an immediate “new plan.”

This validates the product split in the parent workflow: the Mini App is the dense visual feedback surface, while Telegram remains the place for clarifications and agent-led progress.

## Important findings

### The correct feedback interaction is batched, not per-cell submission

The first prototype version submitted every individual edit immediately. Phone testing exposed that this felt wrong: the parent should first collect thoughts across the week, then intentionally ask Kipp to replan. The resulting interaction should be:

```text
Local meal drafts → visible “Feedback ready” state → Replan once
  → explicit “Feedback sent” confirmation → return to Telegram
  → agent asks clarifications or sends a new review button when ready
```

The future API should therefore receive one feedback batch with an opaque active-plan version and one idempotency key. It should record the batch and start/continue the agent workflow; it should not claim that a revised plan exists until the agent has actually produced and persisted one.

### Draft recovery matters

Parents can accidentally close, minimize, or leave a Mini App before they are ready to replan. The prototype restored local drafts after close/reopen by using Telegram `DeviceStorage`, keyed to the plan ID and version. Telegram describes this as persistent, bot-scoped storage on the current device; it is appropriate for a temporary UI convenience, not for canonical plan data. [Telegram DeviceStorage](https://core.telegram.org/bots/webapps#devicestorage)

Production implications:

- preserve unsent drafts only for the matching plan version;
- visibly tell the parent that drafts were restored;
- clear them after successful submission, explicit discard, or replacement by a newer plan;
- do not rely on this mechanism for cross-device recovery, audit history, or household state;
- decide whether diet/allergy-sensitive feedback is acceptable in device-local storage, and document the retention behavior.

### The Mini App should close at the agent handoff

After Kipp accepts the batch, the parent needs a clear acknowledgement—not a stale plan board. The tested pattern is a brief **Feedback sent — Kipp will continue in this Telegram chat** view followed by `Telegram.WebApp.close()`. This worked on the test phone and made the next place to act unambiguous.

For production, use a server-recorded job/status and a Telegram progress message. The agent can then ask a clarification in the chat, or send a fresh **Review updated plan** button only after the new plan version is available.

## Technical findings carried forward

- The existing bot and a contextual inline Web App button are sufficient for this flow; no second bot or native app is required.
- A real Telegram launch needs a public HTTPS URL. Local development works through `pnpm dev` plus ngrok and the separate development bot webhook.
- The raw `Telegram.WebApp.initData` can be validated server-side. The prototype verified its HMAC, freshness, one-time consumption, authorized user, short session, schema validation, idempotency, and stale-version rejection.
- The Mini App must never trust `initDataUnsafe`, client-provided user/household/plan identifiers, or route parameters as authority. Telegram’s documented signed-data validation remains mandatory. [Telegram Mini App validation](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
- The prototype intentionally uses in-memory mock state. A Worker restart loses it; this is not a D1 result and must not be interpreted as production persistence validation.

## What the prototype did not prove

- iOS and cross-platform layout/keyboard/theme behavior; testing was on one physical phone.
- A real agent workflow, clarification interpretation, or eventual revised meal plan.
- Durable plan, feedback, job, and audit persistence; D1 was deliberately excluded.
- Cross-device draft restoration, draft encryption/retention policy, or privacy UX.
- Production-level duplicate delivery, queueing, retry, or recovery when the Mini App request succeeds but its response is lost.
- Correct chat-context recovery in every Telegram launch mode. The prototype used a private bot chat and treated the verified user ID as the reply destination; production should persist the originating authorized chat context when creating the review interaction rather than infer it.

## Required production design decisions

1. **Canonical state:** use D1 (or the separately chosen transactional store) for households, plan versions, feedback batches, agent jobs, clarification state, and audit metadata. DeviceStorage is never canonical.
2. **Versioning:** feedback references the exact active plan version. Reject a stale batch atomically and return a clear “a newer plan is available” state.
3. **Delivery and retries:** give each feedback batch a durable idempotency key. Separate “batch accepted” from “agent notification delivered,” and make retries safe if the phone loses its response.
4. **Conversation ownership:** persist the originating private chat and workflow interaction context. Route agent clarification replies through the existing Telegram conversation mechanism.
5. **Plan publication:** persist a new plan version before notifying the parent. The notification opens the new version; the old board must never silently become the new plan.
6. **Draft policy:** define device-local draft retention, explicit discard, invalidation on a new plan version, and privacy implications.
7. **Security:** replace the prototype bearer token with the selected production session/CSRF design; keep Telegram validation and resource-level household authorization server-side.

## Validation evidence

- Focused Mini App tests cover signed/invalid/expired/replayed/unauthorized launches, authenticated plan reads, batch acceptance, idempotency, stale-version conflict, invalid payloads, session expiry, and bot clarification notification.
- The full repository suite passed: **422 tests passed; 6 credential-gated tests skipped**. TypeScript and documentation checks also passed.
- Manual development-bot testing confirmed Mini App launch, multiple local drafts, batch handoff, automatic closing, Telegram clarification, and close/reopen draft restoration on one phone.

## Recommended next step

Use this report as input to the separate production implementation plan. Begin that plan with the durable data model and agent/job state machine, then build the Mini App against those real contracts. Add iOS/Android acceptance testing before treating the Mini App review surface as ready for household use.
