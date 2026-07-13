#!/bin/bash
# Reset an idea to "raw" status for re-testing locally.
# Usage: ./scripts/reset-idea.sh <idea-id>

set -euo pipefail

ID="${1:?Usage: $0 <idea-id>}"

eval "$(grep -E '^(GITHUB_PAT|DATA_REPO_OWNER|DATA_REPO_NAME)=' .dev.vars)"

URL="https://api.github.com/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/contents/ideas.md"

RESP=$(curl -sf -H "Authorization: Bearer $GITHUB_PAT" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "User-Agent: reset-idea" \
  "$URL")

SHA=$(echo "$RESP" | jq -r '.sha')
CONTENT=$(echo "$RESP" | jq -r '.content' | base64 -d)

NEW=$(echo "$CONTENT" | awk -v id="$ID" '
  /^---$/ { yaml++ }
  yaml == 1 && $0 ~ "^id: " id "$" { found=1 }
  yaml == 1 && found && /^status:/ { print "status: raw"; next }
  yaml == 1 && found && /^correlation:/ { skip=2; next }
  skip > 0 { skip--; next }
  /^## Draft/ { draft=1 }
  draft { next }
  { print }
')

BODY=$(echo "$NEW" | base64)
curl -sf -X PUT -H "Authorization: Bearer $GITHUB_PAT" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "User-Agent: reset-idea" \
  -H "Content-Type: application/json" \
  "$URL" \
  -d "$(jq -n --arg content "$BODY" --arg sha "$SHA" --arg id "$ID" '{message: ("reset idea " + $id + " to raw"), content: $content, sha: $sha}')" > /dev/null

echo "Idea #$ID reset to raw."
