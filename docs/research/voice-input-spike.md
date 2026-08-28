# Voice Input for Weekly Meal Planning — Issue #61

**Status:** decision complete  
**Scope:** voice-note transcription is deferred; Kipp accepts text input, including
on-device dictation supplied as ordinary Telegram text.

## Decision sought

Decide whether v1 should add server-side transcription for Telegram voice
notes, or keep Kipp's input boundary text-only and rely on the device's
dictation experience when speaking is more convenient.

**Decision: keep Kipp text-only for v1.** The parent may use the phone
keyboard's speech-to-text and send the result as a normal Telegram message.
This preserves a voice-friendly experience without Kipp receiving, downloading,
storing, or transcribing audio. Revisit native voice-note support only if
on-device dictation proves materially inadequate for the household.

## Product source of truth

Issue [#61](https://github.com/satwikhebbar/kipp/issues/61) identifies a
text-only Telegram ingress and asks for a validated voice-input approach for
representative weekly planning messages, including correction and safe audio/
transcript handling. It is feasibility work under
[#59](https://github.com/satwikhebbar/kipp/issues/59), whose complete product
contract is the [School-Day Meal Planning Workflow — v1 Product
Specification](https://github.com/satwikhebbar/kipp/blob/main/docs/school-day-meal-planning-workflow-spec.html).

That contract requires:

- typed entry, including device-dictated text when speaking is easier, for
  weekly inventory, exceptions, and short meal-specific change requests;
- a concise, ordinary-language inventory/exception summary for the parent to
  confirm or correct before planning;
- source- and timestamped, week-scoped patches that apply only unambiguous,
  low-risk facts automatically; consequential ambiguity requires a short
  question; and
- expiry of weekly state with the plan, with no promotion to persistent
  household context unless the parent explicitly chooses it.

## Rationale and deferred option

The current Kipp Telegram ingress already accepts and routes text. Device
dictation therefore has no backend latency, transcription cost, AI binding,
audio-retention policy, download-token exposure, or new failure path. Kipp
continues to apply the same confirmation-first treatment to the resulting text:
it proposes a week-scoped patch or a targeted question, and writes no
consequential change until the parent confirms it.

Cloudflare's `@cf/openai/whisper` remains the preferred future option if
native Telegram voice notes become necessary. It is Cloudflare's hosted
offering of OpenAI Whisper, not a distinct transcription model; adding it now
would create an audio ingress and lifecycle surface without a present need.
[Cloudflare Whisper](https://developers.cloudflare.com/workers-ai/models/whisper/)

The product specification should be amended in its next revision to say
"typed text, including device dictation" wherever it currently requires Kipp
to transcribe a Telegram voice note. This is a product-scope clarification,
not an implementation gap.

## Multiple dictated or typed messages for meal-cell feedback

**Process each Telegram text message as an independent, ordered input.** A
sequence can refer to different meal cells, and combining messages before the
parent can review them makes attribution, correction, and retries ambiguous. A
short burst can be presented as one pending-review group only after every
message retains its own source record and result.

### Required ordering and idempotency contract

1. On webhook receipt, create an immutable intake record keyed by
   `chatId:telegramMessageId` (and retain `update_id` as delivery metadata).
   Re-delivery of that key returns the existing record; it never applies a
   second patch.
2. Assign each record a per-chat sequence from the Telegram message ID. State
   transitions finalize in sequence so that a later message cannot alter plan
   state ahead of an earlier message.
3. Parse each text input into **one proposed, source-linked patch or one
   clarification**. A message replying to a visual meal cell is scoped to that
   cell; otherwise, do not guess which cell it changes.
4. Apply no patch until its associated parent confirmation. A confirmation
   carries the intake key and base plan version; consume it once. If the plan
   has changed, re-render the affected cell(s) and ask for reconfirmation,
   rather than rebasing a stale correction silently.
5. Give each item a visible terminal result: “ready to review,” “needs one
   detail,” “couldn't apply that change—please rephrase it,” or “confirmed.”
   Retries use the same intake key and an attempt counter; they must not
   duplicate confirmed changes.

### Latency and optional presentation grouping

For adjacent messages from the same chat that arrive within a short,
documented quiet window (for example 30 seconds), Kipp may show a single
**Review 3 changes** message containing three independently editable entries.
Confirmation still occurs per entry unless the parent explicitly selects
“confirm all.” This keeps a short burst readable without delaying a single
meal-cell correction and preserves source provenance.

## Acceptance criteria for closing the spike

This spike is complete with the recorded v1 decision: use device dictation to
produce ordinary Telegram text; do not accept, download, or transcribe voice
notes in Kipp. The follow-up implementation plan must retain the documented
text-message idempotency, cell attribution, confirmation/version checks, and
optional presentation grouping.

## Recommended delivery sequence

1. Implement the meal-planning text capture and confirmation flow.
2. Make device dictation discoverable in the parent-facing instructions, while
   keeping typing equally supported.
3. Carry the documented text-message ordering, cell attribution, idempotency,
   and plan-version safeguards into the meal-plan review implementation.
4. Re-open a narrowly scoped voice-note spike only if device dictation proves
   inadequate. Its first server-side candidate should be Cloudflare-hosted
   OpenAI Whisper.

## Sources

- [Kipp issue #61](https://github.com/satwikhebbar/kipp/issues/61)
- [Kipp issue #59](https://github.com/satwikhebbar/kipp/issues/59)
- [School-Day Meal Planning Workflow — v1 Product Specification](https://github.com/satwikhebbar/kipp/blob/main/docs/school-day-meal-planning-workflow-spec.html)
- [Cloudflare Workers AI: OpenAI Whisper](https://developers.cloudflare.com/workers-ai/models/whisper/)
