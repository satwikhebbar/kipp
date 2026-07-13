# Manual Test Plan — LinkedIn Posting Pipeline

This test plan is for practical manual verification of the current workflow. It focuses on the critical paths we are likely to use in real life, with extra attention on token handling and accidental-action risks.

## Scope

We want confidence in five things:

1. Telegram messages only drive the workflow when they should.
2. The workflow can draft, pause, revise, resume, and finish cleanly.
3. GitHub-backed state stays accurate through the loop.
4. LinkedIn draft creation uses the expected credentials and never auto-publishes.
5. Personal access tokens and webhook secrets are not leaked or used in obviously unsafe ways.

## Out of Scope

- Rare provider outages or extended third-party downtime
- Heavy concurrency across many users
- Extreme malformed payload fuzzing
- Load or performance testing

This is a personal automation, so we should spend time on the cases we will actually hit.

## Test Environment

Run these against the environment you actually plan to use for day-to-day operation:

- Cloudflare Worker + Workflow deployed
- Real Telegram bot configured
- Private GitHub data repo connected
- LLM provider configured
- LinkedIn app configured

Before starting, make sure you know:

- The Worker URL
- The Telegram bot chat you will use
- The private data repo branch
- Whether LinkedIn auth is being sourced from `.linkedin-tokens.json`, env secrets, or both

## Pre-Flight Safety Checks

Do these once before running the rest:

1. Confirm `.dev.vars` is ignored by git and not staged.
2. Confirm no PAT, bot token, webhook secret, LinkedIn token, or client secret is present in:
   - tracked files
   - `plans/`
   - `.agent-handoff/`
   - test fixtures
3. Confirm the Telegram webhook is configured with a secret token.
4. Confirm `TELEGRAM_ALLOWED_USER_ID` is set to your own Telegram user id.
5. Confirm the GitHub PAT is scoped only to the private data repo you intend to use.
6. Confirm LinkedIn workflow behavior still creates a `DRAFT` only, never a published post.

## Test Data

Use two or three realistic ideas:

- A short raw thought captured from Telegram
- A longer idea that benefits from revision
- One idea you are comfortable turning into a real LinkedIn draft

Avoid using sensitive personal notes for the test run because drafts and revisions will be written to the private repo.

## Test Cases

### 1. Telegram quick capture stores a raw idea

Steps:

1. Send `/add A short test idea about building reliable personal automations`.
2. Open `ideas.md` in the private data repo.

Expected:

- A new raw idea is appended.
- The saved idea body matches the Telegram message.
- The bot acknowledges the save in Telegram.
- No workflow starts automatically from `/add`.

Security check:

- The stored idea should not contain unrelated token values or secrets from configuration.

### 2. `/generate` starts the workflow on the oldest raw idea

Steps:

1. Ensure there is at least one raw idea.
2. Send `/generate`.
3. Watch Telegram and the Worker logs / workflow instance list.

Expected:

- A workflow instance starts.
- The oldest raw idea is selected.
- The idea status changes away from `raw` and into the drafting flow.
- A draft notification arrives in Telegram with inline actions.

### 3. Draft notification correlation is correct

Steps:

1. After the draft message arrives, inspect the corresponding idea entry in `ideas.md`.
2. Verify correlation fields after notification.

Expected:

- The workflow instance id is stored.
- The Telegram chat id is correct.
- The bot message id matches the draft message that was sent.

Why this matters:

- This is the link that lets replies and inline buttons resume the correct workflow.

### 4. Reply-based revision works end to end

Steps:

1. Reply directly to the bot’s draft message with practical feedback such as `Shorter opening, more personal, stronger ending`.
2. Wait for the revised draft response.

Expected:

- The workflow resumes from the wait state.
- A revised draft arrives in Telegram.
- The draft content in `ideas.md` updates.
- The workflow stays in an awaiting-feedback state rather than archiving early.

### 5. Inline “Revise More” flow works

Steps:

1. Tap `Revise More`.
2. Send a normal message in the same chat with revision feedback.

Expected:

- The bot prompts you to type revision feedback.
- The next message is consumed as workflow feedback.
- A revised draft comes back.
- The pending revision marker is cleared after the feedback is consumed.

Practical caution:

- After running this, verify that normal commands still behave normally. For example, `/add something else` should not be swallowed as revision feedback.

### 6. Approval creates a LinkedIn draft and archives the idea

Steps:

1. Tap `Approve`.
2. Watch the workflow complete.
3. Check Telegram, `ideas.md`, `archive.md`, and LinkedIn.

Expected:

- A LinkedIn draft is created.
- Nothing is auto-published.
- The idea moves from `ideas.md` to `archive.md`.
- Telegram confirms success.
- The archived entry contains the final draft text you approved.

Security check:

- Confirm the LinkedIn result is a draft visible in the compose UI, not a live post.

### 7. Timeout path marks the idea as expired

Steps:

1. Use a short temporary wait duration in a test environment if needed.
2. Start a workflow and do not respond.
3. Wait for the feedback window to expire.

Expected:

- The workflow times out cleanly.
- The idea is marked `awaiting-feedback-expired`.
- Nothing is posted to LinkedIn.
- The idea is not archived as if it succeeded.

### 8. Unauthorized Telegram request is rejected

Steps:

1. Send a webhook request without the correct `X-Telegram-Bot-Api-Secret-Token`.
2. Separately, if practical, test with a Telegram user id that is not the allowed one.

Expected:

- Wrong or missing webhook secret returns unauthorized.
- A disallowed user cannot trigger capture, revision, or approval.
- No idea or workflow state changes occur from those requests.

Security check:

- Verify these rejected requests do not create stray entries in `ideas.md`.

### 9. GitHub state remains coherent after a full draft → revise → approve cycle

Steps:

1. Run one idea through capture, generate, at least one revision, and approval.
2. Inspect the markdown files after each stage.

Expected:

- `ideas.md` reflects the current active state during the loop.
- `archive.md` receives the final approved item once done.
- There is no duplicate copy of the same idea across both files after completion.
- Correlation data points to the latest Telegram bot message during the active review loop.

### 10. LinkedIn token source is the one you expect

Steps:

1. Determine whether the system is intended to read from `.linkedin-tokens.json`, `LINKEDIN_ACCESS_TOKEN`, or use one as fallback.
2. Perform one approval run with the current production-like setup.
3. If you have both configured, intentionally note which one should win and verify behavior.

Expected:

- The workflow uses the intended token source consistently.
- Approve succeeds when the intended token is valid.
- If token refresh has updated `.linkedin-tokens.json`, the publish path should not silently keep using an older secret value.

Security check:

- Token files remain only in the private repo.
- Refreshed tokens are not copied into logs, plans, or chat artifacts.

### 11. Token refresh warning path is actionable

Steps:

1. Simulate or use a near-expiry LinkedIn token state.
2. Run the token-check cron or trigger its handler in your normal testing flow.

Expected:

- If refresh works, `.linkedin-tokens.json` is updated.
- If refresh does not work, you receive a Telegram alert with a clear next step.
- The system does not keep failing silently.

Practical follow-up:

- After refresh or manual replacement, run one real approval test to confirm the publish path now works.

### 12. Secret hygiene after a run

Steps:

1. After completing the tests, inspect:
   - Worker logs
   - Telegram messages
   - `ideas.md`
   - `archive.md`
   - any handoff files
2. Look specifically for token values, authorization headers, refresh tokens, client secrets, or webhook secrets.

Expected:

- Secrets do not appear in user-visible messages or persisted content.
- Error messages are useful without exposing credentials.

## Suggested Test Order

Run in this order to get fast confidence:

1. Pre-flight safety checks
2. Quick capture
3. `/generate`
4. Reply-based revision
5. Inline `Revise More`
6. Approval to LinkedIn draft
7. GitHub state coherence check
8. Unauthorized request rejection
9. Token source verification
10. Token refresh warning path
11. Timeout path
12. Final secret hygiene pass

## Pass Criteria

We should consider the workflow ready for personal use if:

- We can capture an idea, generate a draft, revise it, approve it, and see a LinkedIn draft created.
- Unauthorized Telegram traffic does not mutate state.
- The GitHub backlog stays coherent through the loop.
- The token source is consistent and understandable.
- No secrets appear in persisted content, logs, or operator-facing messages.

## Notes for This Project

- Because this is a single-user workflow, it is okay to deprioritize multi-user and heavy concurrency scenarios.
- Because LinkedIn drafts are the final handoff, the most important safety rule is still: approval should create a draft only, never publish automatically.
- If any ambiguity remains around whether LinkedIn publish reads from `.linkedin-tokens.json` or `LINKEDIN_ACCESS_TOKEN`, resolve that before trusting the token-refresh flow.
