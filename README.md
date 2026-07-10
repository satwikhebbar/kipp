# LinkedIn Posting Pipeline

An automated LinkedIn posting pipeline on **Cloudflare Workers + Workflows**. Captures ideas, drafts posts, runs a critique–revise loop with Telegram-based feedback, and creates a LinkedIn **DRAFT** (never auto-published).

Designed as an **open-source template**. Your data and credentials stay in a separate private repo.

## How It Works

```
Substack RSS (daily) ──→ ideas.md ──→ Pipeline Workflow ──→ LinkedIn DRAFT
Telegram capture                  ↑                ↕
Telegram /generate ───────────────┘          Telegram feedback loop
Cadence check (weekly) ──────────┘
```

The workflow pauses indefinitely at each "awaiting feedback" step, waiting for your Telegram reply — zero cost during idle time (powered by `step.waitForEvent()`).

## Prerequisites

- Node.js 20+
- pnpm 9+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- Cloudflare account (Workers Paid — $5/mo)
- Telegram bot (from [BotFather](https://t.me/BotFather))
- LinkedIn Developer App (with Posts API)
- A **private GitHub repo** for your data (`ideas.md`, `archive.md`, `style-prompt.md`)
- An LLM API key (Gemini Flash by default, DeepSeek as budget alternative)

## Setup

### 1. Fork this repo

```bash
gh repo clone your-org/linkedin-pipeline
cd linkedin-pipeline
pnpm install
```

### 2. Create your data repo

Create a **private** GitHub repo (e.g., `linkedin-pipeline-data`) containing:

- `ideas.md` — your idea backlog (see [example/ideas-template.md](example/ideas-template.md))
- `archive.md` — empty file (will hold published posts)
- `style-prompt.md` — your writing style guide (see [example/style-prompt.md](example/style-prompt.md))

### 3. Telegram bot

Talk to [BotFather](https://t.me/BotFather), create a bot, note the token.
Set a webhook after deploying:

```
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-worker.your-subdomain.workers.dev/webhook/telegram&secret_token=<WEBHOOK_SECRET>"
```

### 4. LinkedIn app

1. Go to https://developer.linkedin.com/ → Create App
2. Add the **Share on LinkedIn** product (free tier)
3. Get OAuth 2.0 access token via the [OAuth 2.0 playground](https://developer.linkedin.com/oauth/tools)
4. Note the access token and refresh token (if available)

### 5. Deploy

```bash
pnpm wrangler deploy
```

Then set secrets:

```bash
pnpm wrangler secret put TELEGRAM_BOT_TOKEN
pnpm wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm wrangler secret put LINKEDIN_ACCESS_TOKEN
pnpm wrangler secret put LINKEDIN_REFRESH_TOKEN
pnpm wrangler secret put LLM_API_KEY
pnpm wrangler secret put LLM_PROVIDER
pnpm wrangler secret put GITHUB_PAT
pnpm wrangler secret put DATA_REPO_OWNER
pnpm wrangler secret put DATA_REPO_NAME
```

### 6. Register Telegram webhook

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://linkedin-pipeline.your-subdomain.workers.dev/webhook/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### 7. Verify

- Send a message to your Telegram bot — it should appear in `ideas.md`
- Send `/generate` — it should start the pipeline
- Check the Cloudflare dashboard for Workflow runs

## Usage

| Action | How |
|---|---|
| Quick-capture idea | Send any message to the Telegram bot |
| Start pipeline | Send `/generate` |
| Give feedback | Reply to a bot draft notification |

The pipeline will **never** auto-publish. All finished drafts land as LinkedIn DRAFT posts for you to review and publish manually.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Start local dev server (wrangler) |
| `pnpm deploy` | Deploy to Cloudflare Workers |
| `pnpm lint` | Check lint rules and formatting |
| `pnpm lint:fix` | Auto-fix lint and formatting issues |
| `pnpm typecheck` | Run TypeScript type checking |
| `pnpm test` | Run all tests |
| `pnpm check` | Run lint + typecheck + test (use before committing) |

Pre-commit hooks (via lefthook) run `typecheck`, `lint`, and `test` automatically on every commit. Initialize them with `pnpm lefthook install` after cloning.

## Project Structure

```
src/
├── index.ts                 # Worker entry (Hono routes)
├── workflow.ts              # Workflow orchestration
├── types.ts                 # Shared types
├── backlog/                 # ideas.md / archive.md management
├── agent/                   # LLM agent steps (draft, critique, revise, classify)
├── providers/               # LLM provider clients (Gemini, DeepSeek)
├── triggers/                # Triggers (RSS, cadence, Telegram webhook)
└── integrations/            # External APIs (GitHub, LinkedIn, Telegram)
```

## License

MIT
