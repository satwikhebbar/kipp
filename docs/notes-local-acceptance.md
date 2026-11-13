# Notes local acceptance and production readiness

This runbook exercises the implemented Telegram → writer → approval → Buffer
workflow on localhost, using the development bot and the connected Substack
account. Buffer acceptance completes a run; checking cards is a release-time
inspection, not a new delivery-monitoring requirement.

Execution and evidence belong to Beads `agent-harness-11x7`; editorial acceptance
belongs to `agent-harness-5bp9`. This document is the procedure, not a completion
tracker. Preparing it does not deploy, change account configuration or publish.

## Current inspection

Local configuration was inspected on 2026-11-13 without printing secret values.

| Item | Finding |
| --- | --- |
| `wrangler.local.toml` | Present; includes `NOTES_WORKFLOW`, `BUFFER_PUBLICATIONS`, existing vault/router and migration tags `v1`–`v4`. |
| Effective local values | Telegram token/secret/allowed user, OpenRouter key, GitHub token/repository, Buffer client credentials/origin/channel, timezone and listed encryption-key values are non-empty. Validity has not been tested in this inspection. |
| Development access | `DEPLOYMENT_ENV=development` and the local setup access fallback are enabled. |
| Notes prompt | No `PROMPT_NOTES_PATH` override. Existence/quality of the repository's `notes-style-prompt.md` remains to be verified. |
| Tracked production structure | Contains Notes Workflow, Buffer publication object and `v4`. Deployed state and Dashboard values were not inspected. |
| Tracked local template | `wrangler.toml` lacks the Notes binding/migration entries. Existing local config is ready structurally; a fresh checkout needs the additions below. |

No server, tunnel, database migration, consent flow or live publication was run
as part of this inspection. Previously stored local authorization may still work;
its presence and usability must be checked through setup rather than token dumps.

## Environment prerequisites

| Capability | Local setup | Production setup |
| --- | --- | --- |
| Telegram | Separate development bot; `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_ID`. One active tunnel/webhook/worktree. | Production bot and matching webhook secret/allowed user in Dashboard. |
| Writer | `OPENROUTER_API_KEY` with access/budget for pinned `openai/gpt-6-luna`. Shared `LLM_MODEL` does not select the Notes model. | Provision the existing OpenRouter secret in Dashboard and verify model access. |
| Writing prompt | `GITHUB_PAT`, `DATA_REPO_OWNER`, `DATA_REPO_NAME`; optional `PROMPT_NOTES_PATH`. Verify the actual selected file and review its audience/style. | Same access and reviewed prompt. Do not rely on an accidental missing-file fallback for release. |
| Buffer app | `BUFFER_CLIENT_ID`, `BUFFER_CLIENT_SECRET`; `BUFFER_REDIRECT_ORIGIN=https://<reserved-dev-host>`. Register exactly that origin plus `/auth/buffer/callback`. | Register the production HTTPS callback separately and set production origin/client credentials in Dashboard. |
| Destination | `BUFFER_SUBSTACK_CHANNEL_ID`, connected Substack channel and working queue slots. | Provision/validate the intended single channel separately. |
| Encryption | `TOKEN_ENCRYPTION_KEY_IDS` and a valid base64url 32-byte `TOKEN_ENCRYPTION_KEY_<id>` for each listed ID; preserve keys needed to decrypt existing grants. Presence alone does not establish key validity. | Preserve existing key ring in Dashboard. Never copy local encrypted vault records into production. |
| Timing/review | Valid IANA `TIMEZONE`; verify effective `WAIT_FOR_FEEDBACK_HOURS` and `LLM_MAX_RETRIES`, including `.dev.vars` overrides. | Set deliberate production values. Effective review window is capped at 11h45m. |
| Setup access | Existing explicit development fallback, or a real Access-protected development hostname. OAuth needs HTTPS and a browser cookie round trip. | `ACCESS_TEAM`, `ACCESS_AUDIENCE`, `ACCESS_ADMIN_EMAILS`; Access protects setup/callback/admin routes. Only `/webhook/telegram` has the Telegram bypass. No insecure local fallback. |

Secrets stay in ignored `.dev.vars` locally; non-secret text belongs in local
`[vars]`. Production values/secrets belong in Cloudflare Dashboard, never a
production `[vars]` block. Keep the full existing runtime contract for other
workflows; Notes itself does not use Notion as an idea source. GitHub reads do
not currently use `DATA_REPO_BRANCH` to select a branch: inspect the repository's
default-branch prompt. Only missing files cause fallback; authentication/network
errors must be repaired.

The enabled development fallback bypasses setup authentication. Before opening
the tunnel, use a protected development hostname or restrict tunnel access to
setup/admin routes while allowing Telegram's authenticated webhook and the
browser's OAuth callback. Do not treat an obscure tunnel URL as authentication.
Keep callback query strings and tokens out of tunnel/request captures.

## Storage, migrations and infrastructure

**Notes requires no D1 SQL migration, new D1 database, KV namespace or cron.**
It uses existing vault/router objects and a new per-publication SQLite Durable
Object, plus a Workflow binding. All production entries are already tracked.

| Resource | Local handling | Production handling |
| --- | --- | --- |
| `TOKEN_VAULT` / `TokenVaultDO` | Existing `v1` SQLite class; encrypted Buffer grant uses Durable Object storage. | Retain existing class, namespace, keys and records. Authorize Buffer separately in production. |
| `INTERACTION_ROUTER` / `InteractionRouterDO` | Existing `v2`; schema initializes in application code. | Retain existing namespace and migration history. |
| `BUFFER_PUBLICATIONS` / `BufferPublicationDO` | `v4` declares the SQLite class. Constructor creates `publication` and `attempts` tables automatically. No manual SQL command. | Worker deployment applies pending Durable Object lifecycle declarations; tables initialize on first object use. Preserve evidence thereafter. |
| `NOTES_WORKFLOW` / `NotesWorkflow` | Binding name `NOTES_WORKFLOW`, workflow name `kipp-notes`; Wrangler emulates locally. | Deployed with the tracked manifest. No separate manual SQL/bootstrap call. |
| `MEAL_PLANNING_DB` | Unrelated existing D1. `pnpm dev` runs the package's `predev` hook to apply local migrations. | Normal deployment script applies pending meal-planner D1 migrations before uploading. These are shared-app maintenance, not Notes schema. |

For a fresh local config, add these blocks without overwriting existing values
or removing earlier migration tags. The current worktree already has them:

```toml
[[durable_objects.bindings]]
name = "BUFFER_PUBLICATIONS"
class_name = "BufferPublicationDO"

[[migrations]]
tag = "v4"
new_sqlite_classes = ["BufferPublicationDO"]

[[workflows]]
binding = "NOTES_WORKFLOW"
name = "kipp-notes"
class_name = "NotesWorkflow"
```

Local state persists under `.wrangler/state`; restart the server without deleting
it. Do not reset publication records or rotating-token claims to recover a test.
Local and production storage/consent are independent even when using the same
external Buffer account.

## Preflight and startup

Run from the repository root. Commands use the project's RTK wrapper.

```bash
rtk proxy pnpm check
rtk proxy pnpm test:integration
rtk proxy pnpm deploy:check
```

These verify the whole app and dry-run the production bundle; they neither
deploy nor establish Dashboard/account readiness. The obsolete migration test
suite is retired. Optional bounded real-LLM tests can be run for Notes only,
with `OPENROUTER_API_KEY` supplied securely to the process:

```bash
rtk proxy env WORKFLOW_SANITY_LIVE=1 pnpm exec vitest run src/__contract__/workflow-sanity.contract.test.ts -t notes
```

That suite keeps Telegram/Buffer simulated. Each scenario allows 12 model calls,
5 simulated user turns, 16,384 output tokens per call, 98,304 total output tokens
and four minutes; these are ceilings, not expected consumption.

Then start the existing local environment:

```bash
rtk proxy pnpm dev
```

The `predev` hook applies local D1 migrations. If starting Wrangler directly,
perform the shared-app step explicitly first:

```bash
rtk proxy pnpm exec wrangler d1 migrations apply MEAL_PLANNING_DB --local --config wrangler.local.toml
rtk proxy pnpm exec wrangler dev --config wrangler.local.toml
```

In separate terminals, after verifying only the intended worktree owns 8787:

```bash
rtk proxy curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/
rtk proxy ngrok http 8787 --domain=<reserved-dev-host>
rtk proxy pnpm run webhook:dev
```

Expect health `200`, successful webhook registration, and no missing-binding or
schema error. Confirm the detected tunnel is the intended one; the webhook
script selects an active HTTPS tunnel. Do not change the production bot webhook.
Local crons are unnecessary for `/note` tests.

Open `https://<reserved-dev-host>/setup/buffer` in a browser on the same hostname
used for the callback. Complete consent if needed, approving `account:read`,
`posts:read`, `posts:write`, `offline_access`. Expect the correct Substack channel,
connected/unlocked state and scheduling permission. Resume a paused queue in
Buffer before the queue test. If configuration changes, restart local Wrangler
and start a new run. Setup failures restart at `/setup/buffer`, never a reused
callback URL. Establish a dedicated test queue slot if convenient; don't alter
existing real content or its schedule.

## Live walkthrough

Run one conversation at a time. Before each approval inspect the final literal
text, card URL and timing. Use sensible non-sensitive content even though it is
temporary. The following examples are seed thoughts; judge the generated final
text rather than expecting an exact sentence.
Normal reviews combine commentary, timing and the Note in one Telegram message
with a visible divider before the Note and a review keyboard. Connection setup
is its own turn: it retains thoughts and does not produce a draft until Continue
confirms connection. Only oversized review content is split.

| Case | Steps | Expected result |
| --- | --- | --- |
| 1. Text-only immediate and revision | Send `/note Small releases make feedback easier to act on. One useful change is easier to discuss than ten bundled together.` Check commentary → timing → exact Note. Tap Revise, request one concrete change, then inspect the new draft. Tap an old approval; also type `publish` as feedback before using the current Publish button. | No post before current explicit button approval; Revise alone does not draft. Old approval cannot publish. Typed feedback may consume a writing round but cannot publish. Final text needs no Substack edit; exactly one Buffer acceptance and one Note. |
| 1a. Missing connection, when present | If local Buffer consent is missing, run case 1 before connecting. Expect only the setup prompt; open Connect Buffer, complete consent and return to tap Continue. | No draft or writing call accompanies the setup prompt. Continue retains original thoughts/link/receipt time and drafts after setup succeeds, without spending a writing turn on setup or publishing. Failed Continue reoffers setup only. Publication still needs explicit review approval. This case adds no extra submission to case 1. |
| 2. Queue placement | Send the same thought with `Add this to my Buffer queue.` Inspect and tap Add to queue. | Queue timing and button are clear. Confirmation shows Buffer's assigned time in configured timezone when returned. Inspect the Buffer queue once to compare content/time; remove this test item before it goes live. If no time is returned, acceptance without an invented time is correct. |
| 3. Exact schedule | Use `Post tomorrow at 9am Asia/Kolkata` with a sensible thought. Review the resolved date/time and Schedule button; revise only the prose once and approve. Use a comfortably future time. | Revision preserves the resolved instant. Buffer scheduled time matches the reviewed instant and content. Remove the test item before due time. Do not wait for delivery. |
| 4. Substack article card | Add one real, appropriate Substack article URL to a new thought. Review the exact card URL and approve immediate publication. | One correct embedded card; literal Note body matches the approved text. User inspects once and deletes this test Note. |
| 5. External card / masked Telegram hyperlink | Paste a Telegram hyperlink with a short visible label targeting a stable public non-Substack article; optionally add a second different URL afterward. Approve immediate publication. | Original entity order selects the first URL target, even if masked; later URL is not a second card. Commentary shows the selected URL. One correct embedded card. Inspect once and delete the test Note. |
| 6. Timing clarification without publishing | Request two conflicting modes, e.g. `Add to queue and publish now`. Answer the clarification with an exact future time and explicit IANA zone. Then give feedback to switch back to queue. | No approval during unresolved timing. Final timing/buttons reflect each explicit change; no silent immediate fallback. Do not approve this case. |
| 7. Link changes without publishing | Start a linked thought, then request `Remove the link card`; later provide a different URL and ask to use it. | Commentary/draft reflect remove/replace; revision invalidates older controls. Do not approve this case. |
| 8. Review-window and writing-budget behavior | In a separate last run, make short revision requests until all five logical writing sessions are used. | Last valid draft remains available with fresh controls and clear limit behavior. No unintended publication. Expiry is covered automatically; optionally repeat with a shorter local review window in a separate run, then restore configuration. |

Cases 1–5 create at most five accepted test submissions: three immediate Notes
and two future Buffer items. Double-tap the final case-1 approval after success
to check that it cannot create a duplicate. Keep each case within the review
budget; start a new run if extra feedback is needed. Pending unapproved runs
can expire; no Cancel command is assumed.

An optional live repair exercise may revoke **only the development app grant**
after review, then approve and follow Connect Buffer → same-account consent →
current Retry. Expect either automatic refresh if the grant is still usable or
a definitive pre-create repair notice. Reauthorization alone must never post;
an eligible Retry must send only the unchanged approved payload. Run this only
if the grant can be isolated from production/other clients. Otherwise use the
existing automated refresh/repair cases; do not break a shared production grant
or manually corrupt vault storage to manufacture expiry.

## Checks kept automated

The existing Notes integration/recovery suites cover unauthenticated/wrong-owner
events, stale and duplicate callbacks, exact fingerprints and deadlines,
first-link parsing, missing queue time, pre-create repair limits, account/channel
changes, invalid/past/DST timing, bounded writing failures, router redelivery,
rotation persistence/concurrency and Workflow/SQLite restart boundaries.

Do not reproduce network-loss or storage-fault experiments with real publishing.
A lost create response is intentionally terminal and must not acquire a Retry
button. If a live outcome is uncertain, stop that case, inspect Buffer/Substack
once and decide independently what to keep/delete. Never repeatedly approve,
reset the publication object or submit the same thought automatically.

## Evidence and cleanup

Record in Beads the commit tested, local runtime/configuration summary (no
values), selected prompt path/SHA, case outcomes, workflow IDs, Buffer post IDs,
reviewed/returned times, cleanup outcome and any anomaly. Do not copy credentials,
callback URLs, full vault records or private draft text into shared diagnostics.
Assess factual fidelity, brevity, author voice and usefulness explicitly;
functional success alone cannot accept the provisional writing prompt.

The user deletes the three immediate test Notes in Substack. Remove the queue
and scheduled items in Buffer before their due times; deleting only a visible
Note does not cancel a future Buffer item. Verify each test item is accounted
for. Buffer cannot delete an already-published Substack Note through this
integration. Preserve local publication evidence; stop the tunnel/server after
testing and keep the development webhook distinct from production.

## Production promotion criteria

Local acceptance is necessary but does not test Cloudflare Access or production
provisioning. Before a separately authorized deployment:

1. Resolve functional anomalies and accept the actual editorial prompt. Record
   automated checks against the release commit, plus the live walkthrough.
2. Verify Dashboard variables/secrets and Access policies against
   `config/runtime-variables.json` and the environment table above. Preserve
   existing integrations and encryption keys; disable development fallback and
   full prompt transcript logging. Verify query-string redaction.
3. Compare deployed infrastructure/migration history with `wrangler.prod.toml`.
   Retain `v1`–`v4`, all existing Workflows, D1 and KV. An unapplied `v4` is a
   pending Durable Object deployment migration, not a manual SQL script.
4. Run `pnpm deploy:check`. Inspect pending D1 migrations separately if any;
   `pnpm run deploy` applies them remotely before Worker upload. Deploy only
   with separate authorization. No destructive migration/reset is part of Notes.
5. After upload, verify redaction, production Notes Workflow/bindings and health.
   Complete protected Buffer consent on the production hostname and validate
   the configured channel. Local OAuth does not provision the production vault.
6. Run a minimal production bot smoke: draft/revise, then one approved sensible
   test submission in the chosen mode, inspect acceptance and clean it up.
   Account access/consent and this deployed path are the differences a localhost
   test cannot establish. Repeat other modes only if production configuration
   differences or failures justify them.

Release evidence must say whether production provisioning, editorial acceptance,
local live tests and post-deployment smoke actually passed; planned checks do
not count as results. An older Worker upload does not undo accepted Buffer posts
or remove Durable Object migration history/evidence.

See [Buffer setup and recovery](buffer-setup.md) and
[production runtime configuration](production-runtime-configuration.md).
