# Telegram Mini App review spike — findings for issue #62

**Status:** proposed completion plan  
**Decision sought:** whether Kipp can use a Telegram Mini App as a safe, usable
mobile visual review surface for the School-Day Meal Planning v1 workflow.

## Spike goal

Issue [#62](https://github.com/satwikhebbar/kipp/issues/62) is not a request to
build the meal-planning product. It is a risk-reduction spike: prove a narrow
end-to-end review path in which a parent can open a weekly plan in Telegram,
see a phone-usable Monday–Saturday grid, and submit feedback without allowing
untrusted client data or a stale view to change the wrong plan. The parent
issue, [#59](https://github.com/satwikhebbar/kipp/issues/59), makes the Mini
App the **visual** surface and keeps Telegram as the conversational surface.

The proposed decision is to proceed only if the pilot demonstrates all of:

1. Telegram identity is verified on Kipp's server from raw signed `initData`;
   no browser-provided Telegram ID, URL parameter, or route hint grants access.
2. A parent can read the current weekly grid, open a meal's details, and record
   targeted feedback on an actual target phone without the six-day layout
   becoming unusable.
3. Feedback is bound to a base plan version, is idempotent, and conflicts
   rather than silently overwrites a newer plan.
4. The same existing Kipp bot can launch the screen contextually, while a
   future neutral Kipp home remains possible for other workflows.

## Product contract the pilot must preserve

The parent specification requires a Monday–Saturday plan that is easy to scan
and adjust, gives each cell a glanceable view plus details, supports feedback,
shows pending changes, and preserves accepted meals during midweek changes.
Feedback guides the agent rather than directly replacing a cell; the current
plan remains visible until the parent asks for a revised plan. The planning
decisions further require D1 to be the canonical structured store, versioned
plans, and rejection of stale feedback. [v1 product specification](../school-day-meal-planning-workflow-spec.html)
[planning decisions](../school-day-meal-planning-planning-decisions.md)

Therefore this spike should explicitly exclude full profile editing, agent
planning/replanning, image input, recipe discovery, history UI, multi-bot
support, and a native app. It only needs sufficient representative plan data
and one persisted feedback operation to validate the interface and safety
boundaries.

## Recommended prototype

Use the existing bot and a Kipp-controlled HTTPS web origin. Launch the pilot
from a private-chat inline **Review this week's plan** Web App button. Do not
create a separate meal-plan bot. A Main Mini App named **Kipp Home** is a
follow-up only if the contextual flow proves useful; this avoids making the
bot's permanent entry point workflow-specific.

```text
Telegram private chat → Review this week's plan button → Kipp Mini App
                                                    │ raw initData
                                                    ▼
                                    POST /api/mini/session
                                    validate Telegram HMAC + freshness
                                    authorize Kipp member/household
                                                    │
                                                    ▼
                              versioned plan read + feedback write in D1
```

The client sends raw `Telegram.WebApp.initData` to the server. The server
validates the documented HMAC data-check string and a short `auth_date`
freshness window, maps the validated user to a Kipp member, then creates a
short-lived first-party session. Every read and write scopes the opaque plan ID
to that authorized member/household. Telegram warns that `initDataUnsafe` is
untrusted; the signed raw data must be validated server-side. [Telegram:
validating Mini App data](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)

For the write path, submit `{ baseVersionId, feedback, idempotencyKey }`.
Persist an auditable feedback batch only when `baseVersionId` is current. On a
version conflict, return the current plan/version and require the parent to
review again. This directly exercises the parent plan's “do not replan
accepted meals” constraint rather than merely rendering a mock grid.

## Completion evidence and exit decision

Run the prototype with one authorized household and representative data: five
meal slots across six days, realistic cell detail, at least one pending change,
and one deliberately stale tab/session.

The spike is complete when its evidence records:

- server-side valid, expired/replayed, malformed, and cross-household identity
  cases, with only the valid authorized user able to read or submit feedback;
- a successful feedback submission, retry with the same idempotency key, and a
  stale-version submission that conflicts without changing the current plan;
- phone checks in Telegram on Android and iOS (including light/dark themes),
  showing that the grid is readable, cell details are reachable, text entry is
  not obscured by the keyboard, and the pending/saved/error states are clear;
- a parent usability judgment that this is faster or clearer than reviewing
  the same plan in chat or as an image; and
- a documented architecture/UX decision: proceed to implementation, revise
  the interaction model, or keep review in Telegram.

Telegram requires Web App URLs to be HTTPS in the production Bot API flow and
provides the Web App SDK for viewport/theme integration. Its developer terms
also place hosted-app security, privacy policy, retention/deletion, and
reasonable safeguards on Kipp, so a pilot must not treat the Telegram WebView
as the security boundary. [Telegram Bot API: WebAppInfo](https://core.telegram.org/bots/api#webappinfo)
[Telegram Mini Apps SDK](https://core.telegram.org/bots/webapps#initializing-mini-apps)
[Telegram Bot Developer Terms](https://telegram.org/tos/bot-developers)

## Delivery sequence

1. Create a responsive, read-only board with static representative plan data;
   validate the layout on target Telegram clients before adding product logic.
2. Add the session endpoint and server-side Telegram verification; fetch the
   active plan only after the Kipp session is established.
3. Add one cell-level feedback action and its version/idempotency/conflict
   behavior, backed by the proposed canonical plan store.
4. Add the contextual launch button and run the acceptance scenarios above.
5. Record the results and decide whether to promote the pilot into #59's
   implementation plan. Do not add a Main App, broad profile editing, or
   multi-workflow navigation before this decision.

## Sources

- [Kipp issue #62](https://github.com/satwikhebbar/kipp/issues/62)
- [Kipp parent issue #59](https://github.com/satwikhebbar/kipp/issues/59)
- [School-Day Meal Planning Workflow — v1 Product Specification](../school-day-meal-planning-workflow-spec.html)
- [School-Day Meal Planning: Planning Decisions](../school-day-meal-planning-planning-decisions.md)
- [Telegram Mini Apps](https://core.telegram.org/bots/webapps)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram Bot Platform Developer Terms](https://telegram.org/tos/bot-developers)
