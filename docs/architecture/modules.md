# Modules

The dependency direction is from orchestration and entry points toward domain
modules and integrations. `backlog`, `agents`, `providers`, `prompts`, and
`crypto` do not depend on the Worker entry point, a trigger, or the workflow.

```mermaid
flowchart LR
  entry["index.ts\nWorker entry point"] --> triggers["triggers"]
  entry --> workflow["workflow"]
  entry --> vault["token-vault"]

  triggers --> backlog["backlog"]
  triggers --> integrations["integrations"]
  triggers --> providers["providers"]
  triggers --> workflow
  triggers --> vault

  workflow --> agents["agent"]
  workflow --> backlog
  workflow --> conversation["conversation"]
  workflow --> prompts["prompts"]
  workflow --> providers
  workflow --> integrations
  workflow --> vault

  backlog --> github["integrations/github"]
  prompts --> github
  agents --> providers
  vault --> crypto["crypto"]
```

| Module | Responsibility | Key dependencies |
| --- | --- | --- |
| `triggers/` | Adapts HTTP and scheduled events into application actions. | Backlog, integrations, providers, workflow, token vault |
| `workflow.ts` | Orchestrates draft, critique, revision, notification, approval wait, and archive actions. | Agents, backlog, conversation, integrations, prompts, providers, token vault |
| `backlog/` | Parses and mutates the Markdown idea backlog and archive. | GitHub integration |
| `agent/` | Builds drafting, critique, revision, and classification behavior over a normalized generator. | Providers |
| `providers/` | Selects Gemini or DeepSeek and normalizes the generation interface. | Provider SDK/API |
| `integrations/` | Implements GitHub, Telegram, and LinkedIn API clients. | External APIs |
| `prompts/` | Resolves the style prompt from the data repository with a built-in fallback. | GitHub integration |
| `token-vault.ts` + `crypto.ts` | Stores OAuth state and encrypts LinkedIn tokens at rest. | Durable Object SQLite, Web Crypto |
| `conversation.ts` | Builds the workflow conversation transcript and enforces Workflow output limits. | Provider message types |

`types.ts` supplies shared data contracts. Tests are consumers of these modules,
not a production architecture layer.
