#!/usr/bin/env bash
set -euo pipefail

# Cloudflare Dashboard check (reminder only — can't enforce from here)
echo "Reminder: Verify ACCESS_TEAM, ACCESS_AUDIENCE, and ACCESS_ADMIN_EMAILS"
echo "         are set in Dashboard → Workers & Pages → linkedin-pipeline → Settings → Environment Variables."
echo ""

# ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK must never be set in wrangler.toml (only in untracked .dev.vars)
if grep -Eq '^ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK[[:space:]]*=[[:space:]]*"true"' wrangler.toml 2>/dev/null; then
  echo "ERROR: ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK is set to \"true\" in wrangler.toml."
  echo "       This is unsafe for production. Keep it only in .dev.vars (gitignored)."
  echo "       Remove the line from wrangler.toml before deploying."
  exit 1
fi
