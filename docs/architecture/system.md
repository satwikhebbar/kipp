# System and runtime

Kipp is a Cloudflare Worker that captures content ideas, generates and revises
LinkedIn copy, and creates a LinkedIn **draft** only after explicit Telegram
approval. It never publishes a post directly.

## System context

```mermaid
flowchart LR
  user["Owner"]
  telegram["Telegram Bot API"]
  rss["Substack RSS feed"]
  access["Cloudflare Access"]
  worker["Kipp Cloudflare Worker"]
  workflow["Cloudflare Workflow"]
  vault["TokenVault Durable Object"]
  data["Private GitHub data repository"]
  llm["Gemini or DeepSeek API"]
  linkedin["LinkedIn OAuth and Posts API"]

  user <--> telegram
  telegram --> worker
  rss --> worker
  user --> access --> worker
  worker --> workflow
  worker <--> vault
  worker <--> data
  workflow <--> telegram
  workflow <--> data
  workflow --> llm
  workflow <--> vault
  workflow --> linkedin
  vault --> linkedin
```

## Cloudflare containers

`src/index.ts` provides the Worker entry point and Hono HTTP routes. It also
dispatches the three configured cron schedules. The worker delegates business
work to trigger handlers and `PipelineWorkflow`; it does not own the core draft
loop itself.

```mermaid
flowchart TB
  subgraph cf["Cloudflare account"]
    worker["Worker + Hono\nsrc/index.ts"]
    triggers["Trigger handlers\nsrc/triggers"]
    workflow["PipelineWorkflow\nsrc/workflow.ts"]
    vault["TokenVaultDO\nDurable Object + SQLite"]
    worker --> triggers
    worker --> workflow
    worker --> vault
    triggers --> workflow
    triggers --> vault
    workflow --> vault
  end

  triggers --> ext["External APIs"]
  workflow --> ext
```

The Worker has five HTTP routes: the health response, Telegram webhook,
LinkedIn OAuth start and callback, and administrative token rewrapping.
Cloudflare Access protects the Worker hostname in production. A separate Access
application bypasses only `/webhook/telegram` so Telegram can deliver updates;
the Worker then verifies Telegram's webhook-secret header and allowed-user
configuration. Setup, OAuth callback, and rewrapping require a valid Access JWT
in the Worker.
