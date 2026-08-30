#!/usr/bin/env bash
set -euo pipefail

node tools/verify-runtime-config.mjs

echo "Reminder: Wrangler does not yet support observability.redact_query_string in TOML."
echo "          After a live upload, verify in Cloudflare Dashboard that query-string redaction is enabled."
echo ""

cfg="wrangler.prod.toml"

if ! grep -Eq '^keep_vars[[:space:]]*=[[:space:]]*true' "$cfg"; then
  echo "ERROR: $cfg must set keep_vars = true."
  echo "       Cloudflare Dashboard is the source of truth for production runtime variables and secrets."
  exit 1
fi

if grep -Eq '^\[vars\]' "$cfg"; then
  echo "ERROR: $cfg must not define [vars]."
  echo "       Keep production runtime values in Cloudflare Dashboard so deploys cannot remove omitted variables."
  exit 1
fi

for cfg in wrangler.prod.toml; do
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
