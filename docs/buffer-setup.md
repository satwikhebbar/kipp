# Connect Buffer

Buffer setup is optional. Existing LinkedIn and Calendar workflows do not need
Buffer configuration. The implemented workflow supports `/note` drafting, necessary clarification, revisions,
one embedded link, immediate/queue/scheduled approval and guarded Buffer submission.
Restart-boundary verification uses production modules in workerd; release remains gated below.

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
files are missing. Each run snapshots the prompt, model and timezone, then
resolves and pins the Buffer destination before starting the writer. A connection
prompt and a writing response are mutually exclusive turns.
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

Send `/note <raw thoughts>` with optional posting instructions. A single review
message contains commentary, timing, then the exact plain-text Note beneath a
visible divider. Connection guidance is a separate setup turn, never included
in the review. Only oversized reviews split across messages, with controls on the
final part. Only the current owner's Publish, Add to queue or Schedule button authorizes submission;
typing “publish” supplies writing feedback. Revise opens a feedback prompt and
does not call the writer until feedback arrives. The initial generation plus
four follow-up writing sessions share the existing capped feedback window.
Necessary clarification also counts; tapping Revise alone does not. Failed bounded
writing sessions use the same Workflow-step retries as LinkedIn, within the same
logical session and with fixed input. These retries do not spend another review
round. If retries are exhausted or the writing limit is reached, the last valid
Note remains available with fresh controls; without a valid draft, the run ends
with a failure notice. Clarification messages have no approval buttons.
If Buffer is unavailable at startup, Kipp retains the original thoughts and sends
only connection/channel repair guidance, with Continue and (when authorization
is missing) Connect Buffer. No writer call, draft or review buttons accompany
that turn. After repair, Continue rechecks and pins the destination, then starts
drafting from the original thoughts. It never publishes or consumes a writing
session by itself. Repeated failed connection checks preserve the fixed review
deadline. Subsequent changes to a pinned destination still require a new run,
as described in publication repair below.
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

## Recovery and operator guidance

| Telegram outcome | Meaning and next action |
| --- | --- |
| Sent to Buffer / Added to queue / Scheduled with Buffer | Buffer accepted the approved payload. The workflow is finished; Buffer owns downstream delivery. Manage later delivery changes in Buffer/Substack. |
| Not submitted, with Retry | A known pre-create failure occurred. Repair the stated connection, channel or queue issue, then tap the current Retry before it expires. Reconnecting alone never posts. |
| Account or channel changed | Start a new `/note` and review the destination again. Existing approval cannot transfer to another account. |
| Could not confirm submission | The request may have reached Buffer. There is no publishing Retry. Decide independently whether to check Buffer/Substack or reuse the text already visible in Telegram. |
| Unexpected settings | A post exists but did not match the approved settings. Check Buffer; Kipp cannot send another create for that approval. |

An interrupted dispatch remains claimed even if it stopped before sending the
request. This deliberately favors avoiding a duplicate over automatic recovery.
Do not delete/reset a publication object or replay an old approval to force a
send. Retain publication/attempt evidence when investigating. Similarly, an
interrupted rotating-token claim requires Connect Buffer again; never restore
an old refresh token from logs or a backup. Credentials and approved Note text
must not be added to operational logs or shared troubleshooting output.

Automated recovery tests recreate workerd against persistent SQLite/Workflow
stores. They verify retained review authority and saved acceptance, storage
failure before/after create, explicit Retry and supersession, router event
retention/acknowledgement, and rotating-token recovery/fencing. Graceful engine
pause allows a controlled Workflow checkpoint restart; injected storage failures
cover the uncheckpointed mutation boundaries separately. These are regression
checks, not a claim that every possible infrastructure failure is recoverable.

## Release prerequisites

Use the [localhost acceptance and production readiness runbook](notes-local-acceptance.md)
for environment checks, migration handling, live test cases and cleanup.

Implementation and simulated-account verification do not establish production
readiness. Provisioning and the integrated account walkthrough are tracked by
Beads `agent-harness-11x7`. Release requires three separate decisions/actions:

1. **Editorial acceptance:** study author examples and finalize/review the style
   prompt, including audience, voice, brevity, factual fidelity and examples.
   The bundled default is provisional (Beads `agent-harness-5bp9`).
2. **Provisioning:** configure OpenRouter access, GitHub prompt access, Buffer
   OAuth app/redirect origin/channel ID and encryption keys in the intended
   environment. Check channel entitlement and permissions through protected
   setup. Retain the existing `NOTES_WORKFLOW`, `BUFFER_PUBLICATIONS` and `v4`
   manifest entries; no additional Phase 6 binding, variable or migration is
   needed. Verify Cloudflare Access coverage and query-string redaction.
3. **Integrated account walkthrough:** with explicit authorization, use the
   configured dev Telegram bot and production modules to approve text-only
   immediate, queue and exact-time submissions; verify the returned queue time
   and external/Substack article cards, then clean up test content. The earlier
   live spike verified Buffer's API/card behavior but did not exercise this
   complete implementation. Do not automatically retry an uncertain live test.

Run `pnpm check`, `pnpm test:integration` and `pnpm deploy:check` before release. The optional bounded real-LLM suite keeps
account APIs simulated and assesses the writing/tool handoff separately.
The deployment dry-run validates the tracked configuration contract and bundle;
it does not read/verify Dashboard secrets, app entitlement or perform a deploy.
Deployment and real posting require separate authorization. Card inspection here
is a release check, not an ongoing workflow delivery-monitoring step.
