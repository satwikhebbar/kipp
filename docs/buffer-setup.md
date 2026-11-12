# Connect Buffer

Buffer setup is optional. Existing LinkedIn and Calendar workflows do not need
Buffer configuration. Phases 1–5 implement `/note` drafting, necessary clarification, revisions,
one embedded link, immediate/queue/scheduled approval and guarded Buffer submission.
This awaits release and final restart-boundary verification.

Notes drafting uses `openai/gpt-6-luna` through the existing OpenRouter client
and `OPENROUTER_API_KEY`, like the meal planner. Its pinned model is independent
of the shared `LLM_PROVIDER`/`LLM_MODEL` settings used by LinkedIn and Calendar.
Reasoning is disabled for this Chat Completions function-calling path.

1. Connect the desired Substack account inside Buffer. Kipp authorization does
   not create or repair Buffer’s connection to Substack.
2. Register a server-side Buffer OAuth app with the exact callback
   `https://<your-kipp-origin>/auth/buffer/callback`.
3. Set `BUFFER_CLIENT_ID` and `BUFFER_CLIENT_SECRET` as secrets. Set
   `BUFFER_REDIRECT_ORIGIN` to that HTTPS origin, without a path, query or
   fragment. Kipp uses this fixed origin even if a request has another Host.
4. Open `/setup/buffer` through the normal authenticated Kipp setup access and
   approve `account:read`, `posts:read`, `posts:write`, and `offline_access`.
5. If `BUFFER_SUBSTACK_CHANNEL_ID` is absent, the successful callback lists
   available Substack channel names and IDs. Configure the single channel ID
   manually; Kipp never chooses or switches the destination for you. Reconnect
   to check the configured channel and its publishing permissions.

Use `.dev.vars` for local secrets and `[vars]` in `wrangler.local.toml` for
local text configuration. Production values and secrets belong in Cloudflare
Dashboard, as described in [runtime configuration](production-runtime-configuration.md).
The five new registry variables are globally optional: client credentials and
redirect origin are required for Buffer setup; the channel ID is required for
Notes publication. `PROMPT_NOTES_PATH` selects a writing prompt, falling back
to `notes-style-prompt.md` and then a provisional bundled default only when
files are missing. Each run snapshots the prompt, model, timezone and destination.
Production provisioning remains
a release prerequisite; a dry-run does not verify provisioned values.

The callback reports whether the configured channel is available to the
connected Buffer account, is Substack, is connected/unlocked, and permits
scheduling posts. A paused queue is reported separately: resume it inside
Buffer before relying on queue placement. Setup does not alter Buffer settings.
No token, refresh token, verifier or client secret appears in setup output.

The encrypted vault refreshes expiring credentials automatically. Concurrent
requests share one refresh, and both rotated tokens are saved before returning
access. If a refresh response or its durable save cannot be confirmed, Kipp
requires Connect Buffer again rather than reusing a possibly consumed refresh
token. Same-account reauthorization retains the connection identity; changing
the Buffer account changes that identity, so future publication approvals
cannot silently move to another account.

Consent state expires after five minutes and can be consumed once. An expired,
failed or interrupted setup must restart at `/setup/buffer`; do not retry a
callback URL. Do not share callback URLs. Enable **Redact query string** in
Cloudflare Dashboard observability so OAuth codes/state stay out of request
logs. Real setup consent, production provisioning and deployment are separate
release actions; automated tests use synthetic credentials and fake endpoints.

## Notes implementation and release boundary

The structural manifest includes `NOTES_WORKFLOW` (`NotesWorkflow`, `kipp-notes`)
and `BUFFER_PUBLICATIONS` (`BufferPublicationDO`, append-only SQLite migration
`v4`). Local configuration needs the same bindings. This code change does not
deploy those resources or provision production Buffer credentials/channel values.

Send `/note <raw thoughts>` with optional posting instructions. Review commentary
appears first, then timing, then the exact Note in
plain text. Only the current owner's Publish, Add to queue or Schedule button authorizes submission;
typing “publish” supplies writing feedback. Revise opens a feedback prompt and
does not call the writer until feedback arrives. The initial generation plus
four follow-up writing sessions share the existing capped feedback window.
Necessary clarification also counts; tapping Revise alone does not. Failed bounded
writing sessions use the same Workflow-step retries as LinkedIn, within the same
logical session and with fixed input. These retries do not spend another review
round. If retries are exhausted or the writing limit is reached, the last valid
Note remains available with fresh controls; without a valid draft, the run ends
with a failure notice. Clarification messages have no approval buttons.
Posting intent is returned as a separate structured timing proposal by the writer.
With no posting instruction, publication defaults to immediate; prose-only revisions preserve timing.
Queue approval delegates the next slot to Buffer. If Buffer returns its assigned
`dueAt`, the Telegram confirmation shows it using configured `TIMEZONE`, or
explicit UTC when no valid display zone is configured. Missing `dueAt` still
confirms acceptance without guessing a time or polling.

For exact schedules, an explicit IANA timezone overrides configured `TIMEZONE`.
Missing or ambiguous zones, conflicting instructions, DST gaps/overlaps and past
times require clarification. Code converts a valid wall time to UTC; relative
dates use the persisted receipt of the message that supplied the instruction.
The initial and current receipts are supplied separately so an unresolved initial
request survives later clarification. Rewrites keep the resolved instant. Future
eligibility is checked at approval, Retry and immediately before dispatch; an
elapsed schedule never falls back to immediate publication.

Examples:

```text
/note Small releases make feedback easier to act on.
/note Small releases make feedback easier to act on. Add this to my queue.
/note Small releases make feedback easier to act on. Post tomorrow at 9am Asia/Kolkata.
```

The first valid HTTP(S) URL in the original input becomes the single embedded
card, including Telegram hyperlinks whose visible label differs from the target.
A parser uses original UTF-16 entity offsets; later links are ignored. Kipp does
not fetch article contents or generate previews. Commentary identifies the exact
card URL before the timing and Note text. Prose revisions preserve the card;
explicit feedback can remove it or replace it with the first link in that reply.
The writer selects `linkCardAction` (`keep`, `use-input` or `remove`);
application code supplies the actual parsed card URL. Exact approval fingerprints the card
as well as the Note; Buffer acceptance must match both.

The workflow registers opaque actions before displaying buttons and retains
authenticated Notes events across forwarding failures. Telegram redelivery
reuses that event. This does not support concurrent feedback conversations in
one Telegram chat; LinkedIn and Calendar routing behavior is unchanged.

The publication object persists a dispatch claim before each authorized Buffer
create request and stores acceptance separately from Workflow checkpoints.
Successful acceptance confirms immediate publication, queue placement (including
the assigned time when returned), or the exact accepted schedule, then ends;
Kipp does not track delivery. A lost or ambiguous response is terminal, with
no new-create Retry. A definitive pre-create rejection can instead offer Connect
Buffer or channel/queue repair plus explicit Retry of the unchanged Note. There
are at most three guarded attempts. Unchanged Retry expires at the earliest of
fifteen minutes, the original review deadline and the scheduled due time. Fresh
revision feedback remains bounded by the repair/review window and requires new
approval of its timing. Reauthorization alone
never submits. Same-account repair keeps the approved destination; another
account/channel requires a new `/note` and fresh review. Changing content/timing
after rejection seals the old guard before fresh approval, leaving old Retry
buttons inactive. An unexpected existing post also cannot authorize a new
create. If an exact post ID was captured with incomplete evidence, Kipp can
make one bounded lookup of that ID; it never searches for matching text.
Publication evidence has no automatic deletion timer. Draft transcripts use
the existing Workflow retention conventions.

Automated sanity checks drive the real HTTP webhook, Workflows and SQLite
objects with fake account APIs. The optional bounded real-LLM sanity scenario
also keeps Buffer and Telegram simulated. Author voice/example study and an
explicitly authorized integrated account walkthrough remain release prerequisites.
