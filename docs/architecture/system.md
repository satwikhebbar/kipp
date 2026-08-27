# System and runtime

Kipp is a personal workflow assistant on Cloudflare Workers. Telegram is its
primary user interface. Separate durable workflows currently handle LinkedIn
drafting, personal Google Calendar scheduling, and school-week meal planning
while sharing a bounded agent runtime, interaction routing, OAuth storage, and
external integrations.

## System context

```mermaid
flowchart LR
  owner["Owner"] <--> telegram["Telegram Bot API"]
  substack["Substack RSS feed"] --> worker["Kipp Worker"]
  telegram --> worker
  owner --> access["Cloudflare Access"] --> worker

  worker --> linkedinFlow["LinkedIn Workflow"]
  worker --> calendarFlow["Calendar Workflow"]
  worker --> mealFlow["Meal-planning Workflow"]
  worker <--> router["InteractionRouterDO"]
  worker <--> vault["TokenVaultDO"]
  worker <--> ingest["IdeaIngestDO"]

  linkedinFlow <--> data["Notion Ideas data source"]
  linkedinFlow --> github["Optional GitHub style prompt"]
  linkedinFlow --> llm["Gemini or DeepSeek API"]
  linkedinFlow --> linkedin["LinkedIn API"]
  calendarFlow --> llm
  calendarFlow <--> calendar["Google Calendar API"]
  mealFlow --> llm
  mealFlow <--> mealDb["MEAL_PLANNING_DB D1"]
  mealFlow --> mealVideo["RECIPE_VIDEO_CACHE KV"]
  mealFlow <--> youtube["YouTube Data API"]
  linkedinFlow <--> telegram
  calendarFlow <--> telegram
  mealFlow <--> telegram
  linkedinFlow <--> router
  calendarFlow <--> router
  mealFlow <--> router
  linkedinFlow <--> vault
  calendarFlow <--> vault
```

The model is a participant inside each workflow, not the workflow controller.
Workflow-specific, schema-validated tools let it interpret requests and hand
back a terminal outcome. Deterministic code retains authentication, policy,
authorization, revalidation, mutations, and operational recovery.

## Cloudflare containers

```mermaid
flowchart TB
  subgraph edge["Cloudflare Worker"]
    entry["Hono entry point\nsrc/index.ts"]
    triggers["HTTP, Telegram, OAuth, and cron triggers\nsrc/triggers/"]
    entry --> triggers
  end

  subgraph durable["Cloudflare durable components"]
    linkedinFlow["PipelineWorkflow\nLinkedIn generation and review"]
    calendarFlow["CalendarWorkflow\nCalendar conversation and writes"]
    mealFlow["MealPlanningWorkflow\nMeal-planning conversation, persistence, and revisions"]
    router["InteractionRouterDO\nshort-lived Telegram routing"]
    vault["TokenVaultDO\nencrypted OAuth tokens"]
    ingest["IdeaIngestDO\nidempotent idea ingestion and workflow ownership"]
  end

  triggers --> linkedinFlow
  triggers --> calendarFlow
  triggers --> mealFlow
  triggers --> router
  triggers --> vault
  triggers --> ingest
  ingest --> linkedinFlow
  linkedinFlow <--> router
  calendarFlow <--> router
  mealFlow <--> router
  linkedinFlow <--> vault
  calendarFlow <--> vault
  linkedinFlow --> external["External APIs"]
  calendarFlow --> external
  mealFlow --> external
  triggers --> external
```

`src/index.ts` exposes seven routes: health, Telegram webhook, LinkedIn and
Google Calendar OAuth starts, both OAuth callbacks, and administrative token
rewrapping. It also dispatches the daily RSS poll, weekly token check, and
weekly LinkedIn cadence check.

Cloudflare Access protects the Worker hostname in production. A separate
Access application bypasses only `/webhook/telegram`; the Worker still verifies
Telegram's webhook-secret header and allowed user. Setup, OAuth callback, and
rewrapping routes validate the Access JWT inside the Worker.
