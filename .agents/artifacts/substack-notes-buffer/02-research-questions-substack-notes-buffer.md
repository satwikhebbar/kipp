---
type: research-questions
repos:
  - identifier: "satwikhebbar/kipp"
    sha: "8c99e7de1f1e88bfa4eae7c8f7db7786ba128d4e"
flow: prd
---

# Research Questions: Substack Notes through Buffer

## Context pointers

Repository: /Users/satwikhebbar/Projects/agent-harness. Desired behavior is preserved separately in [the request](01-request-substack-notes-buffer.md).

Start with docs/research/substack-notes-api-feasibility.md for prior external findings; verify current Buffer behavior against its primary documentation. Research describes existing behavior and capabilities; product and architecture choices belong in the PRD and technical design.

## Questions

1. **Telegram entry and routing.** How do slash commands, authorization, duplicate deliveries, replies, and callback buttons start or resume workflows today? How are simultaneous conversations and stale interactions handled?
   Start: src/triggers/telegram-webhook.ts, src/core/interaction-router.ts, src/core/interaction-router-client.ts, src/core/edit-workflow.ts, src/integrations/telegram.ts; src/__integration__/telegram-approval-routing.integration.test.ts.

2. **LinkedIn lifecycle and reuse boundaries.** How does a LinkedIn run move from Notion input through generation, revision, approval, and draft creation? Which steps depend on Notion or LinkedIn, and which already use shared services? What state survives retries and restarts?
   Start: src/linkedin/workflow.ts, src/linkedin/ideas/manager.ts, src/core/action-prompt.ts, src/core/workflow-events.ts, src/core/conversation.ts; docs/workflow-edit-lifecycle.md and src/__integration__/workflow-approval-to-linkedin-draft.integration.test.ts.

3. **Writing context and output quality.** Where do author style, source text, and audience instructions enter generation? How are prompts resolved/versioned, revision transcripts retained, exact publishable text separated from review commentary, and output limits enforced? What quality checks or evals exist?
   Start: src/agent/linkedin.ts, src/agent/draft.ts, src/linkedin/prompts/resolver.ts, src/linkedin/prompts/defaults.ts, src/runtime/agent-session.ts, src/runtime/tool-runner.ts; src/__tests__/linkedin-agent.test.ts.

4. **Existing workflow patterns.** How do calendar and meal-planning workflows share infrastructure while keeping their own input, prompts, approval policies, and mutations? What conventions and tests govern workflow registration, logging, errors, and configuration?
   Start: src/calendar/workflow.ts, src/meal-planning/workflow.ts, src/core/types.ts, src/index.ts, docs/architecture/README.md, docs/production-runtime-configuration.md, config/runtime-variables.json, wrangler.prod.toml.

5. **Buffer capabilities and delivery semantics.** What do the current Buffer API and Substack channel expose for authentication, channel discovery, content limits, immediate publishing, status retrieval, published links, quotas, and errors? What documented idempotency or reconciliation mechanisms cover timeouts and retries? How do capabilities vary across supported channels?
   Start: https://developers.buffer.com/guides/getting-started.html, https://developers.buffer.com/guides/your-first-post.html, https://developers.buffer.com/guides/api-limits.html, https://support.buffer.com/articles/using-substack-with-buffer-lDbUYyIq4R. Distinguish documented guarantees from unresolved account-level behavior.

6. **Approval and mutation safeguards.** How does the current system bind approval to a specific draft/revision and user, prevent stale or repeated approvals from causing mutations, and recover when an external write succeeds but its response is lost? Which tests cover authorization, cancellation, expiry, failure, and duplicate writes?
   Start: src/linkedin/workflow.ts, src/core/interaction-router.ts, src/core/action-prompt.ts, src/integrations/linkedin.ts, src/__tests__/workflow.test.ts, src/__integration__/workflow-approval-to-linkedin-draft.integration.test.ts.

## Research boundaries

Use code, tests, and current primary documentation. Report evidence with file/line or source links and flag unknowns. No implementation, account mutation, or live publishing is part of this research.
