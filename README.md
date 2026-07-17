# LinkedIn Posting Pipeline

An automated LinkedIn posting pipeline on **Cloudflare Workers + Workflows**. Captures ideas, drafts posts via LLM, runs a critique–revise loop with Telegram-based feedback, and creates a LinkedIn **DRAFT** (never auto-published).

Designed as an **open-source template**. Your data and credentials stay in a separate private GitHub repo.

## How It Works

```
Substack RSS (daily) ──→ ideas.md ──→ Pipeline Workflow ──→ LinkedIn DRAFT
Telegram capture                  ↑                ↕
Telegram /generate ───────────────┘          Telegram feedback loop
Cadence check (weekly) ──────────┘
```

The workflow pauses indefinitely at each "awaiting feedback" step, waiting for your Telegram reply — zero cost during idle (powered by `step.waitForEvent()`).

## Prerequisites

- Node.js 20+
- pnpm 9+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- Cloudflare account (Workers Paid — $5/mo)
- Telegram bot (from [BotFather](https://t.me/BotFather))
- LinkedIn Developer App (with Posts API)
- A **private** GitHub repo for your data (`ideas.md`, `archive.md`, `style-prompt.md`)
- An LLM API key (Gemini, DeepSeek, etc.)

## Setup

### 1. Fork or clone this repo

```bash
git clone https://github.com/your-org/linkedin-pipeline.git
cd linkedin-pipeline
pnpm install
pnpm lefthook install   # enable pre-commit hooks
```

### 2. Create your data repo

Create a **private** GitHub repo (e.g., `linkedin-pipeline-data`) containing:

- `ideas.md` — your idea backlog (see [example/ideas-template.md](example/ideas-template.md))
- `archive.md` — empty file (will hold published posts)
- `style-prompt.md` — your writing style guide (optional; falls back to the built-in default in `src/prompts/defaults.ts`)

### 3. Create a Telegram bot

Talk to [BotFather](https://t.me/BotFather), create a bot, note the token.

### 4. Create a LinkedIn app

1. Go to [LinkedIn Developer Portal](https://developer.linkedin.com/) → Create App
2. Add the **Share on LinkedIn** product (free tier)
3. Note your **Client ID** and **Client Secret**
4. Add a redirect URL: `https://your-worker.your-subdomain.workers.dev/auth/linkedin/callback`

The OAuth token is obtained via the built-in setup endpoint (see step 5).

### 5. Deploy and configure secrets

```bash
pnpm wrangler deploy
```

Set required secrets (never commit these):

```bash
pnpm wrangler secret put GITHUB_PAT          # GitHub PAT with repo access to your data repo
pnpm wrangler secret put DATA_REPO_OWNER     # GitHub username/org for your data repo
pnpm wrangler secret put DATA_REPO_NAME      # GitHub data repo name
pnpm wrangler secret put TELEGRAM_BOT_TOKEN  # from BotFather
pnpm wrangler secret put TELEGRAM_WEBHOOK_SECRET  # any random string, used for HMAC signing
pnpm wrangler secret put TELEGRAM_ALLOWED_USER_ID  # your Telegram numeric user ID
pnpm wrangler secret put LLM_API_KEY         # Gemini or DeepSeek API key
pnpm wrangler secret put LLM_PROVIDER        # "gemini" or "deepseek"
pnpm wrangler secret put LINKEDIN_CLIENT_ID       # from LinkedIn Developer Portal
pnpm wrangler secret put LINKEDIN_CLIENT_SECRET   # from LinkedIn Developer Portal
pnpm wrangler secret put LINKEDIN_SETUP_SECRET    # any random string, gates the OAuth setup endpoint
pnpm wrangler secret put LINKEDIN_AUTHOR_URN      # your LinkedIn author URN
```

Configurable vars (set in dashboard or `wrangler.toml`):

| Var | Purpose |
|---|---|
| `SUBSTACK_RSS_URL` | RSS feed URL for daily idea capture |
| `LLM_MODEL` | Model name override (e.g. `"gemini-2.0-flash"`) |
| `LLM_MAX_RETRIES` | Retry count for LLM API calls (default `3`) |
| `POSTING_CADENCE_DAYS` | Days between auto-prompted posts (default `7`) |
| `WAIT_FOR_FEEDBACK_HOURS` | Hours to wait for Telegram feedback before timeout (default `12`) |
| `LINKEDIN_REDIRECT_ORIGIN` | Override for OAuth redirect URI (default: derived from `Host`) |
| `PROMPT_STYLE_PATH` | Path to a style prompt in the data repo (default: `style-prompt.md`). Falls back to the built-in default if missing. |

### 6. LinkedIn OAuth setup

Visit the setup URL in your browser (replace `your-subdomain`):

```
https://linkedin-pipeline.your-subdomain.workers.dev/setup/linkedin?secret=YOUR_LINKEDIN_SETUP_SECRET
```

This initiates the OAuth flow:
1. Redirects you to LinkedIn for authorization
2. LinkedIn redirects back to the callback URL
3. The worker exchanges the code for tokens and stores them in your data repo as `.linkedin-tokens.json`

Tokens are automatically refreshed via a weekly cron (`handleTokenCheckCron`).

> The `?secret=` parameter is required only if `LINKEDIN_SETUP_SECRET` is configured. If unset, the endpoint is publicly accessible (not recommended).

### 7. Register Telegram webhook

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://linkedin-pipeline.your-subdomain.workers.dev/webhook/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### 8. Verify

- Send `/add <your idea text>` to your Telegram bot — it should appear in `ideas.md`
- Send `/generate` — it should start the pipeline workflow
- Check the Cloudflare dashboard for Workflow runs

## Usage

| Action | How |
|---|---|
| Quick-capture idea | Send `/add <your idea text>` |
| Start pipeline | Send `/generate` |
| Approve draft | Tap **Approve** on the Telegram notification |
| Request revision | Tap **Revise More** or reply with feedback text |

The pipeline will **never** auto-publish. All finished drafts land as LinkedIn DRAFT posts for you to review and publish manually.

## Secrets vs Vars

| Type | Storage | Used for |
|---|---|---|
| **Secrets** | `wrangler secret put` | API keys, tokens, credentials |
| **Vars** | `wrangler.toml` `[vars]` or dashboard | Configurable but non-sensitive defaults |

Secrets are encrypted and never visible in plaintext. Vars are readable in the Cloudflare dashboard. Never put credentials in `wrangler.toml`.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Start local dev server (wrangler) |
| `pnpm deploy` | Deploy to Cloudflare Workers |
| `pnpm lint` | Check lint rules and formatting |
| `pnpm lint:fix` | Auto-fix lint and formatting issues |
| `pnpm typecheck` | Run TypeScript type checking |
| `pnpm test` | Run all tests |
| `pnpm test:unit` | Run unit tests only |
| `pnpm test:integration` | Run integration tests only |
| `pnpm check` | Run lint + typecheck + test (use before committing) |

Pre-commit hooks (via lefthook) run `typecheck`, `lint`, and `test` automatically on every commit.

## Project Structure

```
src/
├── index.ts                 # Worker entry (Hono routes)
├── workflow.ts              # Workflow orchestration (Cloudflare Workflows)
├── types.ts                 # Shared types
├── backlog/                 # ideas.md / archive.md management
├── prompts/                 # Prompt defaults and runtime resolution
│   ├── defaults.ts          # Built-in default style prompt constant (single source of truth)
│   └── resolver.ts          # readPrompt() — multi-path data repo → built-in fallback
├── agent/                   # LLM agent steps (draft, critique, revise, classify)
├── providers/               # LLM provider clients (Gemini, DeepSeek)
├── triggers/                # Entry points (RSS, cadence, Telegram webhook, LinkedIn OAuth, token refresh)
├── integrations/            # External API clients (GitHub, LinkedIn, Telegram)
├── __tests__/               # Unit tests (vitest)
└── __integration__/         # Integration tests (vitest, with fake network)
```

## License

MIT
