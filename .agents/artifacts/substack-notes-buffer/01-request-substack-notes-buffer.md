---
type: request
repos:
  - identifier: "satwikhebbar/kipp"
    sha: "8c99e7de1f1e88bfa4eae7c8f7db7786ba128d4e"
flow: prd
---

# Original Request: Substack Notes through Buffer

## Desired result

Design a Kipp workflow that lets the author turn raw thoughts sent through a Telegram slash command into a compelling Substack Note, revise it through feedback, and publish through Buffer after explicit approval. Follow research → PRD → technical design; implementation is outside this design task.

The user requested:

> Let's design the substack notes workflow to publish notes regularly via Buffer through prompts initiated by the user on Telegram. Unlike with LinkedIn where we use Notion as a source for ideas, for now, we will expect the user to type some raw thoughts into telegram with a / command to trigger the workflow. The workflow shapes the raw thoughts into a standardized, high quality, humanized note in the style of the author and makes it compelling enough based on the audience that it is designed for, and gets feedback from the user about reshaping it before publishing post an approval.

## Requirements carried forward

- Submit the approved Note to Buffer for automatic immediate/scheduled publication and confirm acceptance; handing off an unpublished draft for manual publication does not meet the request. Returning a public Note link is not required.
- Reuse as much of the LinkedIn drafting, revision, Telegram review, approval, and durable workflow infrastructure as fits.
- Make Buffer extensible so future channels need little destination-specific work.
- Start from Telegram text; no Notion idea source is required for this workflow.
- Keep author voice, audience relevance, concise writing, and factual fidelity central to draft quality.

```text
Telegram /command + raw thoughts
  → shape Note → review ↔ feedback and revision
  → explicit approval → Buffer acceptance → notify and finish
```

## Decisions from the design interview

- **Invocation:** `/note <raw thoughts>`, text only. Empty input shows usage. URLs are valid input; automatic article retrieval, attachments, and voice transcription are outside the initial input contract. Embedded link cards, especially for Substack article URLs, are a requirement to verify against Buffer.
- **Outcome:** one Note for one configured Substack destination per execution. Publish immediately after approval by default; optionally schedule one publication for an explicitly approved future time. Recurring schedules, reminders, and automatic cross-posting remain outside this version.
- **Writing configuration:** one configurable writing prompt contains author voice, audience, and general editorial guidance. The Telegram text supplies the intent and raw material for that execution. Recommend prompt sections that can later become separate properties; multiple audience selection is deferred.
- **Defaults:** match LinkedIn resolution: configured path, conventional prompt file, then a bundled fallback. Casual users can use defaults; custom configuration is optional.
- **Prompt design:** defer the actual editorial prompt until standout Notes examples have been studied for inspiration. Do not treat preliminary editorial recommendations as a finalized prompt.
- **Format:** brief, tweet-like, one focused idea, short paragraphs, well under a minute to read. No mandatory hook, takeaway, closing question, or fixed template; preferences belong in the writing prompt.
- **Clarification:** draft immediately when possible; ask only when drafting would require inventing meaning or facts.
- **Review:** one proposed Note with Publish and Revise actions; revisions can use Telegram feedback. No new Cancel action is required. Each revision needs fresh approval.
- **Publication authority:** Publish locks the exact approved text and destination while delivery proceeds. Older controls lose authority; further feedback cannot modify that pending publication.
- **Delivery uncertainty:** prioritize avoiding duplicate publication. Reconcile Buffer status when possible; report unresolved outcomes honestly and do not blindly retry.
- **Concurrency:** concurrent feedback in the same chat remains unsupported. Do not implement concurrent-feedback routing support as part of this workflow; Notes-specific authority and transport recovery are covered by the approved TDD. The limitation is documented in README; the separate backlog item is https://github.com/satwikhebbar/kipp/issues/101 (documentation pushed in commit 5fa223f).
- **Persistence:** follow LinkedIn's durable-state approach. Introduce no separate content-deletion policy; review expiry is distinct from deletion. Retain publication identifiers/status needed for reconciliation.
- **Reuse:** reuse applicable LinkedIn/shared infrastructure while preserving existing LinkedIn draft behavior. Do not assume a LinkedIn migration to Buffer.

## Further interview decisions (Q12–Q22)

- **Link attachment:** use the first URL in message order as the single card regardless of hostname; ignore subsequent URLs for publication, with no selection/confirmation step. Show the attachment URL during Telegram review. Publish approves both text and attachment; changing either requires fresh approval.
- **Card presentation:** put the first URL in the card; do not add other URLs to the Note body as parenthetical links.
- **URL-only input:** ask what the author wants to say. Do not fetch the article and invent an angle.
- **Review deadline:** use LinkedIn's configured feedback window. Expired Publish/Revise controls cannot be revived; the user starts a new execution, reusing the visible draft if desired.
- **Revision budget:** after generation budget exhaustion, the latest valid draft remains publishable until the review deadline. Decline further generation clearly; do not leave misleading controls.
- **Confirmed publish failure:** retain the approved payload and offer Retry within the review window after connection repair. Retry requires unchanged text, attachment, and destination. Changed payload/destination needs fresh approval; uncertain delivery follows reconciliation instead of blind retry.
- **Authentication:** use Buffer OAuth as the standard connection method. Personal API-key support is outside initial scope. Reuse Kipp setup and encrypted token infrastructure where appropriate. Substack is connected inside Buffer separately.
- **Account scope:** one Substack account per workflow instance; do not add a destination label to the Telegram review.
- **Prompt snapshot:** retain the prompt loaded at execution start throughout revisions; only new executions load prompt changes.
- **Revise action:** ask what should change before generation. A direct reply supplies feedback without the extra tap; “try another version” is valid feedback.

## Remaining design work

The user confirmed shared understanding and authorized code/API research and the PRD. Research is saved in 03-research-substack-notes-buffer.md; PRD and technical design continue through RPI. Technical research must verify Buffer publication/reconciliation and OAuth behavior, reuse boundaries, and review/revision lifecycle handling. Link cards use explicit Buffer attachment metadata; exact Substack article rendering still needs later end-to-end validation. Study standout examples before designing the actual writing prompt. No implementation or live publishing has been authorized.

## Source pointers

- Repository: /Users/satwikhebbar/Projects/agent-harness
- Existing feasibility: docs/research/substack-notes-api-feasibility.md
- RPI: /Users/satwikhebbar/.codex/skills/rpi/SKILL.md
- Buffer API: https://developers.buffer.com/
- Buffer Substack support: https://support.buffer.com/articles/using-substack-with-buffer-lDbUYyIq4R

Tracking: agent-harness-tkfx. Feasibility findings are documentation-level; no account connection or publishing test has been performed.


## Scope update — 10 November 2026

Build basic drafting/revision/publication first. Optional two-to-three-turn exploration toward a deeper core idea is a separate follow-up, tracked as Beads agent-harness-aais. Preserve a boundary for an independent ideation prompt to hand author-confirmed material into the existing drafting phase. Do not implement an exploration flag or natural-language mode switch now; the later entry/transition interaction remains undecided. Research a public skill/prompt as a candidate, not an adopted dependency.

## Scheduling and OAuth update — 10 November 2026

The author added optional one-time scheduling, with immediate publication when no time is specified. URLs are optional, including plain text-only Notes. Handle normal Buffer token expiry with automatic refresh; when authorization cannot be refreshed, request reauthorization and explicit Retry, following the existing Kipp recovery experience. The draft PRD proposes natural-language timing in the trigger or feedback, configured-timezone resolution, explicit timing approval, Buffer-managed scheduling, and no automatic late publication if the requested time passes. These details remain subject to whole-PRD review.

## Buffer acceptance boundary — 10 November 2026

The author clarified that a successful Buffer operation completes Kipp's work. Buffer owns subsequent publication. Remove routine status polling, sleeping until scheduled publication, later success/failure notifications and delayed-link retrieval. Return any link already available, without requiring one. Preserve duplicate prevention and conservative handling of a lost or ambiguous create response; those concern whether Buffer accepted the submission, not monitoring downstream publication. This supersedes earlier delivery-tracking and public-link success requirements.


### Multiple-URL selection clarification — superseded later on 10 November 2026

The author rejected drafting before a per-URL button selection. For multiple URLs, prefer a Substack URL and seek confirmation; otherwise use short URL labels in an alphabetical list and accept a letter reply. Resolve the attachment before drafting. The design treats several Substack candidates as a lettered choice, with those candidates first. Text-only and single-URL behavior remain unchanged.


### First-URL simplification — 10 November 2026

The author explicitly simplified link support: choose the first URL in textual order for one embedded card, regardless of site. Ignore later URLs for publication. Remove the Substack preference, selection lists, confirmation buttons, and multi-link parenthetical fallback. Labelled Telegram hyperlinks remain supported, ordered by their visible text position. Text-only Notes still need no URL. This supersedes earlier multiple-URL selection decisions.


### Program Design setup choice — 10 November 2026

The author chose manual Buffer channel-ID configuration, matching the LinkedIn author-ID pattern. Do not add a channel picker to Connect Buffer setup or routine Notes executions. Straightforward shared time/Calendar daylight-saving validation fixes are included by explicit author request.


### Uncertain submission ends with a failure notice — 10 November 2026

The author chose a simple failure notification when Kipp cannot establish whether Buffer accepted the Note. End the execution and retain the approved text in Telegram; the user decides independently whether to copy it into Substack or Buffer. Do not add a manual-inspection continuation or user-override recreate/Retry action. Distinguish failure to confirm from proof that no Note exists. Known no-create rejection recovery and successful-acceptance completion remain unchanged.


### Design approval and planning continuation — 10 November 2026

The author approved Program Design and requested continuing. PRD and TDD are approved; the next artifact is the implementation outline. Shared time implementation comparison remains an explicit technical gate before selecting a dependency. Editorial prompt acceptance is tracked in agent-harness-5bp9; optional ideation remains agent-harness-aais. No application implementation or live account operations occurred during design/planning.

## Approved Buffer queue extension — 10 November 2026

After creating the Buffer account, the author asked to use its posting queue and approved the explained behavior: “That works. Let's make this a part of our plan and design.” Initial omission keeps immediate publication; explicit queue intent delegates next-slot selection to Buffer; an exact future time requests custom scheduling. The model proposes structured timing, unclear/conflicting instructions clarify, and review exposes the matching Publish/Add to queue/Schedule action. Ordinary revisions preserve timing. Buffer acceptance remains completion; assigned queue time is displayed when returned. This supersedes the original queue-placement exclusion.

## Live feasibility checks complete — 10 November 2026

The author registered the Buffer App Client, connected Substack, approved ngrok transport and completed OAuth consent. All required scopes and one active Substack channel were verified. Normal refresh rotated tokens. Six live test creates covered exact scheduling, queue placement and both external/Substack cards through scheduled and immediate modes. Four future entries were deleted via Buffer; the author confirmed both public cards looked correct and both Notes were deleted. Temporary receiver/tunnel stopped. Actual captured fixtures are separate from synthetic examples. No production workflow or deployment implemented; no live failure/revocation experiments induced.
