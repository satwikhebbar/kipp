# LinkedIn Posting Pipeline

An automated LinkedIn posting pipeline on **Cloudflare Workers + Workflows**. Captures ideas, drafts posts via LLM, runs a critique–revise loop with Telegram-based feedback, and creates a LinkedIn **DRAFT** (never auto-published).

Designed as an **open-source template**. Your content data lives in a separate
private GitHub repository; credentials are kept out of Git in Cloudflare Worker
secrets or local-only development files.

Architecture documentation, including Mermaid diagrams and the machine-readable
architecture inventory, lives in [docs/architecture](docs/architecture/README.md).

## How It Works

```
Substack RSS (daily) ──→ ideas.md ──→ Pipeline Workflow ──→ LinkedIn DRAFT
Telegram capture                  ↑                ↕
Telegram /generate ───────────────┘          Telegram feedback loop
Cadence check (weekly) ──────────┘
```

The workflow durably waits for Telegram feedback without a running Worker
process (powered by `step.waitForEvent()`). It waits for
`WAIT_FOR_FEEDBACK_HOURS` (12 hours by default), then marks the idea
`awaiting-feedback-expired` if no response arrives.

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
git clone git@github.com:satwikhebbar/kipp.git
cd kipp
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
4. Add a redirect URL: `https://<worker>.workers.dev/auth/linkedin/callback`

The OAuth token is obtained via the built-in setup endpoint (see step 5).

### 5. Configure Cloudflare Access

The Worker hostname is protected by Cloudflare Access. Production uses two
**self-hosted** Access applications on the same hostname:

1. A primary application for `https://<worker>.workers.dev` with an **Allow**
   policy for the administrator. This protects every path by default. Record
   its audience value as `ACCESS_AUDIENCE` and set `ACCESS_TEAM` to the Zero
   Trust team name.
2. A second application scoped **only** to
   `https://<worker>.workers.dev/webhook/telegram`, with a **Bypass** policy.
   Telegram cannot complete an interactive Access login, so this narrow bypass
   is required for webhook delivery.

The bypass must not be broadened beyond `/webhook/telegram`. The Worker still
requires Telegram's `X-Telegram-Bot-Api-Secret-Token` header and, when
configured, checks `TELEGRAM_ALLOWED_USER_ID` before it performs any action.
Protected setup, OAuth callback, and administrative routes validate the
Cloudflare Access JWT in the Worker as a second layer of protection.

Configure a separate Access application for preview URLs if preview deployments
are enabled.

### 6. Configure Worker secrets and variables

Set production values in **Workers & Pages → linkedin-pipeline → Settings →
Variables and Secrets** (or with `pnpm wrangler secret put <NAME>`). Do not put
secret values in a committed Wrangler file.

| Type | Names | Purpose |
| --- | --- | --- |
| Secret | `ACCESS_ADMIN_EMAILS` | Comma-separated emails allowed by Worker-side Access JWT validation. |
| Secret | `DATA_REPO_NAME`, `DATA_REPO_OWNER`, `GITHUB_PAT` | Private GitHub data repository access. |
| Secret | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | LinkedIn OAuth client credentials. |
| Secret | `LLM_API_KEY` | Gemini or DeepSeek API credential. |
| Secret | `TELEGRAM_ALLOWED_USER_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Telegram user allow-list, Bot API access, and webhook verification. |
| Secret | `TOKEN_ENCRYPTION_KEY_<key-id>` | 32-byte base64url token-encryption key; the configured key ID determines its exact name. |
| Plaintext variable | `ACCESS_AUDIENCE`, `ACCESS_TEAM`, `DATA_REPO_BRANCH`, `DEPLOYMENT_ENV` | Access validation and deployment configuration. |
| Plaintext variable | `LINKEDIN_AUTHOR_URN`, `LLM_MAX_RETRIES`, `LLM_MODEL`, `LLM_PROVIDER` | LinkedIn identity and LLM behavior. |
| Plaintext variable | `POSTING_CADENCE_DAYS`, `SUBSTACK_RSS_URL`, `TIMEZONE`, `WAIT_FOR_FEEDBACK_HOURS` | Scheduled-trigger and feedback-timeout behavior. |
| Plaintext variable | `TOKEN_ENCRYPTION_KEY_IDS` | Ordered, comma-separated encryption key IDs; the first encrypts and all listed keys can decrypt. |

Set the token encryption key:

```bash
# Generate a 32-byte base64url-encoded key
node -e "const c = require('crypto'); console.log(c.randomBytes(32).toString('base64url'))"
# Store it as a Worker secret. Its suffix must match TOKEN_ENCRYPTION_KEY_IDS.
pnpm wrangler secret put TOKEN_ENCRYPTION_KEY_k20260720a
```

For key rotation, add the new key ID to `TOKEN_ENCRYPTION_KEY_IDS` (for
example, `k20260720a,k20260720b`), add the corresponding secret, and call
`POST /admin/rewrap`. Once rewrapping succeeds, remove the old key ID and
delete its secret.

### 7. Choose the Wrangler configuration

Use `wrangler.local.toml` for local development and `wrangler.prod.toml` for
production deployment. These files hold non-secret `[vars]` only; Worker
secrets stay in the Cloudflare dashboard (production) or `.dev.vars` (local).

```bash
# Local development
pnpm wrangler dev --config wrangler.local.toml

# Production deployment
pnpm wrangler deploy --config wrangler.prod.toml
```

The configuration files define the same runtime bindings and environment
variables for their respective targets. Keep credentials out of both files.

`LINKEDIN_REDIRECT_ORIGIN` and `PROMPT_STYLE_PATH` are optional overrides. The
first overrides the OAuth callback origin; the second selects a style prompt in
the data repository and otherwise falls back to `style-prompt.md` and then the
built-in default.

### 8. LinkedIn OAuth setup

Visit the setup URL in your browser through the Cloudflare Access-protected domain:

```
https://<worker>.workers.dev/setup/linkedin
```

The worker verifies your Access JWT, initiates the OAuth flow:
1. Redirects you to LinkedIn for authorization
2. LinkedIn redirects back to the callback URL
3. The worker validates your Access session, exchanges the code for tokens, encrypts them with AES-256-GCM, and stores them in the Durable Object token vault

Tokens are automatically refreshed via a weekly cron (`handleTokenCheckCron`). A `POST /admin/rewrap` endpoint re-encrypts stored tokens with the current active key encryption key.

### 9. Register Telegram webhook

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<worker>.workers.dev/webhook/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### 10. Verify

- Send `/add <your idea text>` to your Telegram bot — it should appear in `ideas.md`
- Send `/generate` — it should start the pipeline workflow
- Check the Cloudflare dashboard for Workflow runs

## Local Development & Testing

To test the Telegram flow locally without hijacking the production webhook, you must use a separate **dev bot**. Telegram only allows one webhook URL per bot.

1. **Create a Dev Bot**: Talk to BotFather, create a second bot (e.g., `MyBotDev`), and note the token.
2. **Configure `.dev.vars`**: Create a `.dev.vars` file in the project root with your dev bot token and a webhook secret:
   ```env
   TELEGRAM_BOT_TOKEN="dev_bot_token_here"
   TELEGRAM_WEBHOOK_SECRET="some_random_secret"
   ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK="true"
   LINKEDIN_ACCESS_TOKEN="your_linkedin_token"
   TOKEN_ENCRYPTION_KEY_IDS="k20260720a"
   TOKEN_ENCRYPTION_KEY_k20260720a="<base64url-32-byte-key>"
   ```
   `ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK="true"` skips Cloudflare Access JWT verification and falls back to the `LINKEDIN_ACCESS_TOKEN` env var for LinkedIn API calls. Never set this in production.
3. **Start Local Server**: Run `pnpm wrangler dev --config wrangler.local.toml` (usually on port 8787).
4. **Start ngrok**: In a new terminal, expose your local server to the internet using ngrok:
   ```bash
   ngrok http 8787
   ```
5. **Register Dev Webhook**: In another terminal, run the helper script to automatically find your active ngrok URL and point your dev bot's webhook to it:
   ```bash
   pnpm run webhook:dev
   ```
Now, messages sent to your *dev bot* will route to your local server, while your production worker continues to safely handle messages from your production bot.

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
| **Secrets** | Cloudflare dashboard or `wrangler secret put` | API keys, tokens, private repository identifiers, and allow-lists |
| **Vars** | `wrangler.local.toml`, `wrangler.prod.toml`, or dashboard | Configurable, non-sensitive environment settings |

Secrets are encrypted and never visible in plaintext. Vars are readable in the
Cloudflare dashboard. Never put credentials in either Wrangler configuration.

## Commands

| Command | Purpose |
|---|---|
| `pnpm wrangler dev --config wrangler.local.toml` | Start the local Worker with local configuration |
| `pnpm run webhook:dev` | Register dev bot webhook to active ngrok tunnel |
| `pnpm wrangler deploy --config wrangler.prod.toml` | Deploy with production configuration |
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
├── crypto.ts                # AES-256-GCM encrypt/decrypt, base64url helpers
├── token-vault.ts           # TokenVaultDO Durable Object (encrypted token store)
├── token-vault-client.ts    # DO stub client + verifyAccessJwt (Cloudflare Access JWT)
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
