#!/usr/bin/env bash
set -euo pipefail

pnpm run deploy:check
CI=1 pnpm exec wrangler d1 migrations apply MEAL_PLANNING_DB --remote --config wrangler.prod.toml
pnpm exec wrangler deploy --config wrangler.prod.toml

echo 'Verify Cloudflare Dashboard → Observability → Redact query string is enabled.'
