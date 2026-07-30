# Request flows

## Idea capture and generation

Telegram `/add` writes a raw idea to the private data repository. Telegram
`/generate`, the daily RSS poll, and the weekly cadence check can all create a
workflow instance.

```mermaid
sequenceDiagram
  participant U as Owner
  participant T as Telegram
  participant W as Worker trigger
  participant G as GitHub data repo
  participant P as PipelineWorkflow

  U->>T: /add idea
  T->>W: signed webhook
  W->>G: append raw idea to ideas.md
  W-->>T: confirm saved

  U->>T: /generate
  T->>W: signed webhook
  W->>G: read next raw idea
  W->>P: create workflow instance
  W-->>T: confirm started
```

## Draft, review, and LinkedIn draft creation

```mermaid
sequenceDiagram
  participant P as PipelineWorkflow
  participant G as GitHub data repo
  participant L as LLM provider
  participant T as Telegram
  participant U as Owner
  participant V as TokenVaultDO
  participant LI as LinkedIn API

  P->>G: read ideas.md and style prompt
  P->>L: bounded native-tool draft session
  L->>P: submit_linkedin_draft candidate
  P->>G: save draft and awaiting-feedback status
  P->>T: send draft with approval controls
  P->>P: wait for Telegram event
  U->>T: approve or provide feedback
  T->>P: send workflow event
  alt feedback
    P->>L: prior native transcript + feedback
    L->>P: submit_linkedin_draft replacement
    P->>G: replace awaiting-feedback draft
    P->>T: send revised draft with approval controls
  else approval
    P->>V: read encrypted access token
    P->>LI: create LinkedIn post with lifecycleState DRAFT
    P->>G: archive finalized idea and remove it from ideas.md
    P->>T: confirm draft created
  end
```

If the workflow does not receive feedback within `WAIT_FOR_FEEDBACK_HOURS`, it
marks the idea `awaiting-feedback-expired` and ends the run.

## LinkedIn OAuth setup

```mermaid
sequenceDiagram
  participant U as Admin
  participant A as Cloudflare Access
  participant W as Worker
  participant V as TokenVaultDO
  participant LI as LinkedIn OAuth

  U->>A: request /setup/linkedin
  A->>W: authenticated request with Access JWT
  W->>V: issue one-time OAuth state and cookie ID
  W->>LI: redirect to authorization URL
  LI->>W: callback with authorization code and state
  W->>A: validate Access JWT
  W->>V: consume state paired with secure cookie
  W->>LI: exchange code for tokens
  W->>V: encrypt and store tokens
```

The Monday token-check schedule refreshes a token when possible or alerts the
allowed Telegram user when it is near expiry and cannot be refreshed.
