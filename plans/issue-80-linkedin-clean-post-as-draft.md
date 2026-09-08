# LinkedIn: Publish a Cleaned-Up Post as the Draft

> **Status:** Plan for GitHub issue #80 (`[LinkedIn] Post a cleaned up version as draft`).
> **Document role:** Design of the change that stops conversational drafting cruft
> (prelude, hook options, image ideas) from being copied verbatim into the
> LinkedIn DRAFT that Kipp creates on approval.

## 1. Problem

Kipp's LinkedIn pipeline runs a bounded native-tool session
(`src/agent/linkedin.ts`). The model submits exactly one string —
`submit_linkedin_response({ response })` — which the workflow treats as both:

1. the author-facing review message shown in Telegram, and
2. the text Kipp posts to LinkedIn as a DRAFT on approval
   (`createDraftPost(authorUrn, currentDraft)` in `src/linkedin/workflow.ts`).

Because the system prompt asks for "the complete response exactly as it should
appear for human review, including every requested alternative or
recommendation", that single string routinely bundles conversational content
with the actual post. A real production approval looks like:

```text
Here is the post reframed around your preferred hook, with your Substack
observation moved into the story as the starting point.

OPENING HOOK (chosen)
"Reading is the last oversight tool we have left..."

IMAGE IDEAS (pair with the hook)
1. A candid shot from a train or waiting area...
2. Your desk, two worlds side by side...
3. A close-up of a phone screen showing AI output...

THE POST
Reading is the last oversight tool we have left.
...
```

All of that is what gets created as the LinkedIn DRAFT today, forcing the human
author to manually strip the prelude, hook notes, and image ideas inside
LinkedIn before publishing. The human review surface (Telegram) is allowed to
contain that conversational context; the LinkedIn draft is not.

## 2. Outcome

When the author approves a draft, the LinkedIn DRAFT created by Kipp contains
only the actual post body — no conversational prelude, no section labels, no
hook-option notes, no image recommendations. The Telegram review message may
still carry the conversational context the author asked for.

## 3. Design: split the handoff into `response` and `post`

Replace the single-string handoff with a two-field structured contract so the
workflow never has to parse or guess which text is the post. This mirrors how
Calendar already separates an agent-authored explanation from a typed,
deterministic artifact.

### 3.1 Tool contract (`src/agent/linkedin.ts`)

Define the limits at the top of the module:

```ts
const MAX_RESPONSE_CHARACTERS = 10_000 // unchanged: bounds the conversational review message
const MAX_POST_CHARACTERS = 3_000 // ponytail: LinkedIn UGC shareCommentary text limit
```

`MAX_POST_CHARACTERS = 3_000` is a concrete contract choice, not a placeholder:
LinkedIn's UGC Posts API rejects `shareCommentary` text longer than 3,000
characters, so a schema-accepted `post` can never be rejected by
`createDraftPost` for length. The style prompt already targets 150–300 words,
comfortably under the cap; the response field keeps its existing 10,000-char
bound because it is a review message, not the published artifact.

Change the `submit_linkedin_response` input schema from

```ts
z.object({ response: z.string().trim().min(1).max(MAX_RESPONSE_CHARACTERS) })
```

to

```ts
z.object({
  response: z.string().trim().min(1).max(MAX_RESPONSE_CHARACTERS),
  post: z.string().trim().min(1).max(MAX_POST_CHARACTERS),
})
```

Field semantics:

- **`response`** — the complete author-facing review message shown in Telegram.
  May include conversational framing, what changed in a revision, chosen-hook
  rationale, image ideas, or alternatives the author requested. Never published.
- **`post`** — the exact final LinkedIn post text. No prelude, no option labels,
  no image ideas, no section headings such as `THE POST`. This is the only text
  ever passed to `createDraftPost`.

Failure behavior at the boundary: a whitespace/empty `post` and a `post` over
3,000 characters both fail Zod validation in the tool runner, and the session
repairs or fails closed exactly as the current empty-`response` case does (no
publish, no partial state).

The tool handler records both candidates, trims each, and the session result
becomes:

```ts
type LinkedInTerminalOutcome = { kind: "ready_for_review"; response: string; post: string }
```

Keep the tool name (`submit_linkedin_response`) and the terminal outcome kind
(`ready_for_review`) unchanged so the security boundary and interaction
contract stay stable.

### 3.2 Agent prompt

Update `LINKEDIN_AGENT_PROMPT` and the tool `description` to define both fields
and their roles:

- The model must submit the final post in `post` exactly as it should appear on
  LinkedIn, free of conversational framing, alternatives, image suggestions,
  and explanatory headings.
- Anything conversational the author should see while reviewing (why a hook was
  chosen, image ideas, options considered) belongs in `response` only.
- Revision feedback still yields a complete replacement of **both** fields.

### 3.3 Workflow state and publication (`src/linkedin/workflow.ts`)

- In the `generate` step, read both `session.terminal.response` and
  `session.terminal.post`, and carry both in the persisted step-output state
  (alongside the existing transcript, cost, and model fields). The existing
  `assertStepOutputSize` guard automatically covers the added string.
- The author-facing Telegram message (initial `notify` and every
  `notify-revised-*`) continues to render the **response** text under the
  existing `*Draft for idea #N*` header, preserving today's review surface and
  conversational context.
- The approval path calls `createDraftPost(this.env.LINKEDIN_AUTHOR_URN, post)`
  with the **post** field — never the response — for both the first approval and
  any post-revision approval.
- Revision steps (`revise-N`) return complete replacement `response` + `post`
  pairs and update both running values.

Nothing else changes: only an explicit Approve may publish; the token vault,
LinkedIn client, Notion lifecycle, interaction router, and cost accounting are
untouched. No `Env` variable, binding, or `wrangler.toml` change is required.

## 4. File-level change list

| File | Change |
| --- | --- |
| `src/agent/linkedin.ts` | Add `MAX_POST_CHARACTERS = 3_000`; two-field input schema, handler records `post`, `LinkedInTerminalOutcome` gains `post`, prompt + tool description updated. |
| `src/linkedin/workflow.ts` | Carry `post` through step state and revision rounds; approval publishes `post`; notify copy unchanged in substance. |
| `src/__tests__/linkedin-agent.test.ts` | Tool-call fixtures gain `post`; terminal assertions become `{ kind, response, post }`; new cases for trimmed/empty/whitespace `post` and for a `post` over `MAX_POST_CHARACTERS` being rejected by the schema. |
| `src/__tests__/workflow.test.ts` | Provider mock wraps text into both fields; add a test where `response` contains cruft and `post` is clean, asserting the LinkedIn body equals only `post`. |
| `src/__integration__/workflow-approval-to-linkedin-draft.integration.test.ts` | Fixture helper submits both fields; existing assertions updated; new test proves LinkedIn draft text equals `post` and not the conversational `response`, including after a revision. |
| `src/__integration__/security-boundaries.integration.test.ts` | Fixture tool-call arguments gain `post`. |
| `README.md` | Shorten the "LinkedIn drafting and review" wording: the agent returns a review `response` plus the exact post text; only the post text is created as the LinkedIn DRAFT. |

## 5. Verification plan

Targeted suites (run before opening the implementation handoff):

```bash
pnpm test src/__tests__/linkedin-agent.test.ts src/__tests__/workflow.test.ts
pnpm test:integration -- --run src/__integration__/workflow-approval-to-linkedin-draft.integration.test.ts src/__integration__/security-boundaries.integration.test.ts
```

Then the full gate `pnpm check` (lint, JSDoc, typecheck, unit tests).

Explicit behavioral assertions:

1. `response` containing a prelude/hook-notes/image ideas plus a clean `post`
   results in a Telegram review message containing `response` and a LinkedIn
   DRAFT body equal to `post` only.
2. A revision round that returns a new pair publishes the revised `post` on the
   second approval, and the LinkedIn body never equals the conversational
   `response` when the fields differ.
3. Whitespace/empty `post` is rejected by schema and the session fails closed
   (same repair semantics as today's empty `response`).
4. A `post` of exactly `MAX_POST_CHARACTERS` (3,000) is accepted, and a `post`
   of 3,001+ characters is rejected by the schema with the same fail-closed
   repair semantics — proving the documented LinkedIn length boundary is
   enforced before any publish step.
5. No LinkedIn mutation happens before an explicit approval; hallucinated
   publishing tools remain denied (existing security-boundaries cases updated
   only for the new fixture shape).

## 6. Out of scope

- Cleaning up or reformatting the author-facing Telegram message (the response
  may stay conversational by design).
- Parsing/stripping heuristics — the structured field is the mechanism.
- Image attachment support on LinkedIn; the pipeline only ever created a text
  DRAFT, and image ideas remain author-side context in `response`.
- Changes to the Calendar or Meal-planning workflows, the token vault, Notion
  lifecycle, or production runtime configuration.

## 7. Open questions for review

1. Should `response` remain required (min 1 char) alongside `post`, or should it
   become optional so a plain generation with no conversational context submits
   only `post`? Keeping it required preserves the current non-empty handoff
   invariant with the least churn; the plan assumes required.
2. The Telegram header still reads `*Draft for idea #N*` above the `response`
   text. Is that header acceptable now that the LinkedIn draft equals only
   `post`, or should the review message visibly label the exact text that will
   be created (e.g., a trailing `— will be posted as a LinkedIn draft —` block
   quoting `post`)? The plan keeps today's message shape; a labelled block is a
   small follow-up if review prefers more explicitness.

## 8. Acceptance criteria

- [ ] Approval creates a LinkedIn DRAFT whose text is exactly the agent-submitted
      `post`, with no conversational prelude, hook/option notes, or image ideas.
- [ ] Revision + re-approval publishes the revised `post`; the conversational
      `response` is never part of any LinkedIn body.
- [ ] Existing security and approval guards remain intact; all targeted and full
      quality gates pass.
