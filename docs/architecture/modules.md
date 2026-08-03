# Modules

The dependency direction is from orchestration and entry points toward domain
modules and integrations. LinkedIn and Calendar share provider, runtime,
interaction-routing, and token-vault infrastructure while retaining separate
workflow policy.

```mermaid
flowchart LR
  entry["index.ts\nWorker entry point"] --> triggers["triggers"]
  entry --> linkedin_workflow["PipelineWorkflow"]
  entry --> calendar_workflow["CalendarWorkflow"]
  entry --> vault["token-vault"]
  entry --> router["interaction-router"]

  triggers --> backlog["backlog"]
  triggers --> integrations["integrations"]
  triggers --> providers["providers"]
  triggers --> linkedin_workflow
  triggers --> calendar_workflow
  triggers --> vault
  triggers --> router

  linkedin_workflow --> agents["agent"]
  linkedin_workflow --> backlog
  linkedin_workflow --> conversation["conversation"]
  linkedin_workflow --> prompts["prompts"]
  linkedin_workflow --> providers
  linkedin_workflow --> runtime["runtime"]
  linkedin_workflow --> integrations
  linkedin_workflow --> vault
  linkedin_workflow --> router

  calendar_workflow --> calendar_domain["calendar-scheduling + calendar-messages"]
  calendar_workflow --> providers
  calendar_workflow --> runtime
  calendar_workflow --> integrations
  calendar_workflow --> vault
  calendar_workflow --> router

  backlog --> github["integrations/github"]
  prompts --> github
  agents --> providers
  agents --> runtime
  runtime --> providers
  vault --> crypto["crypto"]
```

| Module | Responsibility | Key dependencies |
| --- | --- | --- |
| `triggers/` | Adapts HTTP, Telegram, OAuth, and scheduled events into application actions. | Backlog, integrations, providers, both workflows, interaction router, token vault |
| `workflow.ts` | Orchestrates bounded LinkedIn native-tool drafting/revision, notification, approval wait, deterministic publication, and archive actions. | Agents, backlog, conversation, integrations, interaction router, prompts, providers, runtime, token vault |
| `calendar-workflow.ts` + `calendar-agent-workflow.ts` | Runs the bounded Calendar agent session, persists its safe transcript and opaque plan ledger, maps fixed actions, revalidates fresh state, and performs idempotent writes and recovery. | Calendar agent, Calendar domain, Google Calendar integration, interaction router, providers, runtime, token vault |
| `calendar-evaluation.ts` + `calendar-plan.ts` | Aggregates typed proposal issues, evaluates one-off and recurring candidates, and authorizes versioned single-use plan and option IDs. | Scheduling and recurrence domains, Google Calendar integration |
| `calendar-scheduling.ts` + `calendar-recurrence.ts` + `calendar-messages.ts` | Implements pure scheduling and recurrence policy, conflict alternatives, and deterministic operational or post-write messages. | Shared types, `rrule` |
| `backlog/` | Parses and mutates the Markdown idea backlog and archive. | GitHub integration |
| `agent/` | Defines workflow-specific bounded sessions, prompts, tool contracts, and terminal outcomes for Calendar and LinkedIn. | Providers, runtime, Calendar evaluation |
| `providers/` | Selects Gemini or DeepSeek and normalizes text generation plus native tool declarations, calls, and results. | Provider SDK/API |
| `runtime/` | Supplies the typed tool registry and guard, bounded tool runner, context contract, metadata-only logging, and shared HTTP constants. | Providers, Zod |
| `interaction-router.ts` + `interaction-router-client.ts` | Stores and resolves short-lived opaque Telegram interactions with idempotent claim/acknowledgement and expiry. | Durable Object SQLite |
| `integrations/` | Implements GitHub, Telegram, LinkedIn, and Google Calendar API clients. | External APIs |
| `prompts/` | Resolves the style prompt from the data repository with a built-in fallback. | GitHub integration |
| `token-vault.ts` + `token-vault-client.ts` + `crypto.ts` | Stores short-lived OAuth state and provider-namespaced encrypted LinkedIn/Calendar tokens, including refresh and key rewrapping. | Durable Object SQLite, Web Crypto |
| `conversation.ts` | Preserves serializable LinkedIn transcript state and enforces Workflow output limits. | Provider message types |

`types.ts` supplies shared data contracts. Tests are consumers of these modules,
not a production architecture layer.
