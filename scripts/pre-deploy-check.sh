#!/usr/bin/env bash
set -euo pipefail

# Cloudflare Dashboard check (reminder only — can't enforce from here)
echo "Reminder: Verify ACCESS_TEAM, ACCESS_AUDIENCE, and ACCESS_ADMIN_EMAILS"
echo "         are set in Dashboard → Workers & Pages → linkedin-pipeline → Settings → Environment Variables."
echo ""

for cfg in wrangler.toml wrangler.prod.toml; do
  if grep -Eq '^ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK[[:space:]]*=[[:space:]]*"true"' "$cfg" 2>/dev/null; then
    echo "ERROR: ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK is set to \"true\" in $cfg."
    echo "       This is unsafe for production. Keep it only in .dev.vars (gitignored)."
    echo "       Remove the line from $cfg before deploying."
    exit 1
  fi
done

# LINKEDIN_ACCESS_TOKEN must never be hardcoded in a tracked config file
for cfg in wrangler.toml wrangler.prod.toml; do
  if grep -Eq '^LINKEDIN_ACCESS_TOKEN[[:space:]]*=' "$cfg" 2>/dev/null; then
    echo "ERROR: LINKEDIN_ACCESS_TOKEN found in $cfg."
    echo "       This is unsafe for production. Keep it only in .dev.vars (gitignored)."
    echo "       Remove the line from $cfg before deploying."
    exit 1
  fi
done
