# Data and state

Kipp does not use a conventional application database. Its state is intentionally
split by durability and sensitivity.

```mermaid
flowchart LR
  workflow["PipelineWorkflow"] --> ideas["ideas.md\nactive idea backlog"]
  workflow --> archive["archive.md\nfinalized ideas"]
  workflow --> style_prompt["style-prompt.md\noptional writing style"]
  workflow --> state["Workflow durable state\nsteps and wait events"]
  workflow --> tokens["TokenVaultDO SQLite\nencrypted OAuth tokens"]
  oauth["OAuth routes"] --> tokens
  telegram["Telegram trigger"] --> ideas
  rss["RSS trigger"] --> ideas

  subgraph github["Private GitHub data repository"]
    ideas
    archive
    style_prompt
  end
```

| Store | Data | Lifecycle and protection |
| --- | --- | --- |
| Private GitHub data repository | `ideas.md`, `archive.md`, optional `style-prompt.md` | Accessed with a GitHub PAT; the backlog manager manages parsing, updates, archival, and retention. |
| Durable Object SQLite | OAuth state records and encrypted LinkedIn tokens | OAuth state expires after five minutes. Tokens are encrypted with AES-256-GCM using a configured key ID and can be rewrapped after key rotation. |
| Cloudflare Workflows | Durable steps, draft transcript, and Telegram wait events | A workflow waits for feedback without a running Worker process. Workflow step output is bounded by `conversation.ts`. |

## Idea lifecycle

```mermaid
stateDiagram-v2
  [*] --> raw: Telegram capture or RSS extraction
  raw --> awaiting_feedback: workflow generates draft
  awaiting_feedback --> awaiting_feedback: revision feedback
  awaiting_feedback --> awaiting_feedback_expired: timeout
  awaiting_feedback --> finalized: explicit approval and LinkedIn draft creation
  finalized --> [*]: copied to archive.md and removed from ideas.md
```

`drafted` and `skipped` remain valid domain statuses for data compatibility, but
the current workflow moves a generated idea directly to `awaiting-feedback`.
