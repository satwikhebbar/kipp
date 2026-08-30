# Production runtime configuration

`wrangler.prod.toml` is the version-controlled source of truth for production
deployment structure: bindings, Durable Object lifecycle declarations,
workflows, triggers, compatibility settings, and observability. It has
`keep_vars = true` and no `[vars]` block.

Cloudflare Dashboard is the source of truth for production runtime values and
secrets. Deploying Kipp must preserve that set; do not copy values into the
production TOML. The full value-free contract is
[`config/runtime-variables.json`](../config/runtime-variables.json).

`DATA_REPO_BRANCH` is retained as an additional provisioned variable while it
is unused by the current runtime; it remains in the contract so a deployment
does not accidentally remove it.

## Adding or changing runtime configuration

1. Add the field to `Env` in `src/core/types.ts` and use it in the feature.
2. Add the variable to `config/runtime-variables.json`, classifying it as
   `text` or `secret`, and stating whether production and local development
   require it.
3. Configure its real value locally (`wrangler.local.toml` for text or
   `.dev.vars` for secrets) and in the Cloudflare Dashboard for production.
4. If the change adds a Durable Object, workflow, or cron, update the tracked
   `wrangler.prod.toml` in the same change. Durable Object migrations are
   append-only: retain every prior migration tag.
5. Run `pnpm deploy:check`. It validates the runtime-variable contract, blocks
   unsafe production TOML changes, and performs a Wrangler dry-run.

`pnpm deploy` runs `deploy:check` before its live upload. Never put a secret in
the production TOML, repository, test fixtures, or logs.
