# Request flows

## Telegram ingress and interaction routing

Telegram commands start workflows; replies and callback buttons resume the
specific waiting workflow through short-lived opaque registrations.

```mermaid
sequenceDiagram
  participant U as Owner
  participant T as Telegram
  participant W as Worker trigger
  participant R as InteractionRouterDO
  participant F as Waiting workflow

  U->>T: command, reply, or button
  T->>W: webhook with secret header
  W->>W: verify allowed user and parse command
  alt new command
    W->>F: create LinkedIn or Calendar workflow
  else reply or callback
    W->>R: claim opaque interaction
    R-->>W: workflow target and interaction kind
    W->>F: deliver normalized workflow event
  end
```

## LinkedIn idea capture, generation, and review

Telegram `/add` writes a raw idea to the private data repository. `/generate`,
the daily RSS poll, and the weekly cadence check may start `PipelineWorkflow`.
The LinkedIn agent returns a workflow-specific `ready_for_review` terminal
outcome; it cannot approve, publish, archive, or access credentials.

```mermaid
sequenceDiagram
  participant U as Owner
  participant T as Telegram
  participant W as Worker trigger
  participant G as GitHub data repo
  participant P as PipelineWorkflow
  participant A as Bounded LinkedIn agent
  participant V as TokenVaultDO
  participant LI as LinkedIn API

  U->>T: /add idea or /generate
  T->>W: verified webhook
  W->>G: save or select raw idea
  W->>P: create workflow
  P->>G: read idea and style instructions
  P->>A: bounded native-tool session
  A-->>P: ready_for_review
  P->>G: persist draft and awaiting-feedback state
  P->>T: send draft with Approve and Revise controls
  P->>P: durably wait for interaction
  alt revision feedback
    U->>T: feedback
    T->>P: routed interaction
    P->>A: prior transcript plus feedback
    A-->>P: replacement ready_for_review
    P->>G: replace stored draft
    P->>T: send revised review controls
  else explicit approval
    U->>T: Approve
    T->>P: routed interaction
    P->>V: read LinkedIn token
    P->>LI: create lifecycleState DRAFT
    P->>G: archive finalized idea
    P->>T: confirm LinkedIn draft
  end
```

No LinkedIn post is auto-published. If feedback does not arrive within
`WAIT_FOR_FEEDBACK_HOURS`, the idea becomes `awaiting-feedback-expired`.

## Calendar conversation, evaluation, and write

Calendar uses a bounded agent to interpret ordinary language and explain typed
outcomes. Deterministic evaluation owns date arithmetic, policy, recurrence,
FreeBusy checks, candidate ranking, and opaque plan authorization. Only the
workflow can revalidate and write.

```mermaid
sequenceDiagram
  participant U as Owner
  participant T as Telegram
  participant C as CalendarWorkflow
  participant A as Bounded Calendar agent
  participant E as Guarded Calendar tools
  participant G as Google Calendar API
  participant R as InteractionRouterDO

  U->>T: /calendar natural-language request
  T->>C: create workflow
  C->>A: request plus bounded transcript
  opt reference needs calendar context
    A->>E: list_calendar_events
    E->>G: bounded primary-calendar read
    G-->>E: provider response
    E-->>A: projected titles, timing, opaque references
  end
  A->>E: evaluate_calendar_candidate
  E->>G: FreeBusy read when candidate is valid
  G-->>E: busy intervals
  E-->>A: typed issues, choices, or opaque plan ID
  alt more user input or authorized choices
    A-->>C: needs_user_input
    C->>R: register reply or fixed buttons
    C->>T: agent-authored explanation
    U->>T: reply or select button
    T->>R: claim interaction
    R-->>C: normalized event
    C->>A: resume with reply or changed availability fact
  else candidate ready
    A-->>C: ready_to_create with plan ID
    C->>G: fresh deterministic revalidation
    C->>G: idempotent create or update
    C->>T: deterministic confirmation with Edit
  end
```

`list_calendar_events` is limited to the primary calendar, a 31-day range, 50
projected events, and safe fields. `evaluate_calendar_candidate` performs
availability checks; neither model-facing tool mutates Calendar. Opaque plan
and option IDs are version-scoped, expiring, and single-use. A successful write
is never repeated merely because Telegram confirmation failed.

## OAuth setup

LinkedIn and Google Calendar use the same protected setup pattern and separate
provider namespaces in the encrypted token vault.

```mermaid
sequenceDiagram
  participant U as Admin
  participant A as Cloudflare Access
  participant W as Worker
  participant V as TokenVaultDO
  participant O as Provider OAuth

  U->>A: request provider setup route
  A->>W: authenticated request with Access JWT
  W->>V: issue one-time OAuth state and cookie ID
  W->>O: redirect to authorization URL
  O->>W: callback with code and state
  W->>A: validate Access JWT
  W->>V: consume state paired with secure cookie
  W->>O: exchange code for tokens
  W->>V: encrypt in provider namespace
```

The weekly token check refreshes LinkedIn credentials when possible or alerts
the allowed Telegram user when reconnection is required. Calendar refreshes an
expired access token during a request and offers deterministic reconnect/retry
recovery when authorization is no longer usable.
