#!/usr/bin/env bash
set -euo pipefail

# Fetch and validate ideas.md and archive.md from the data repo
# Usage: ./scripts/check-state.sh [--gh] [--raw]
#   --gh   use gh CLI instead of reading .dev.vars
#   --raw  skip validation, just dump the raw files

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEV_VARS="$SCRIPT_DIR/../.dev.vars"

if [ "${1:-}" = "--raw" ]; then
  RAW_ONLY=1
  shift
fi

if [ "${1:-}" = "--gh" ]; then
  OWNER=$(gh repo view --json owner --jq .owner.login 2>/dev/null || echo "")
  REPO=$(gh repo view --json name --jq .name 2>/dev/null || echo "")
else
  if [ ! -f "$DEV_VARS" ]; then
    echo "No .dev.vars found. Use --gh to use gh CLI instead."
    exit 1
  fi
  OWNER=$(grep 'DATA_REPO_OWNER' "$DEV_VARS" | head -1 | sed 's/.*="//;s/"$//')
  REPO=$(grep 'DATA_REPO_NAME' "$DEV_VARS" | head -1 | sed 's/.*="//;s/"$//')
  PAT=$(grep 'GITHUB_PAT' "$DEV_VARS" | head -1 | sed 's/.*="//;s/"$//')
fi

fetch_file() {
  local file="$1"
  if [ -n "${PAT:-}" ]; then
    curl -s -H "Authorization: Bearer $PAT" -H "User-Agent: check-state" \
      "https://api.github.com/repos/$OWNER/$REPO/contents/$file" | python3 -c "
import json,sys,base64
d=json.load(sys.stdin)
print(base64.b64decode(d['content']).decode(),end='')
" 2>/dev/null || echo ""
  elif command -v gh &>/dev/null; then
    gh api "repos/$OWNER/$REPO/contents/$file" --jq '.content' 2>/dev/null | \
      python3 -c "import sys,base64; print(base64.b64decode(sys.stdin.read()).decode(),end='')" 2>/dev/null || echo ""
  else
    echo "Error: no auth method available"
    exit 1
  fi
}

IDEAS=$(fetch_file "ideas.md")
ARCHIVE=$(fetch_file "archive.md")

if [ -z "$IDEAS" ] && [ -z "$ARCHIVE" ]; then
  echo "Could not fetch files. Check repo ($OWNER/$REPO) and auth."
  exit 1
fi

if [ "${RAW_ONLY:-}" = "1" ]; then
  echo "=== ideas.md ==="
  echo "$IDEAS"
  echo "=== archive.md ==="
  echo "$ARCHIVE"
  exit 0
fi

echo "=== Ideas ($(echo "$IDEAS" | grep -c '^---$')) ==="
echo "$IDEAS" | awk '
  /^id: /   { id=$2 }
  /^status:/ { status=$2; gsub(/"/,"",status) }
  /^---$/ && id { printf "  #%-4s  %s\n", id, status; id=""; status="" }
'
echo ""

echo "=== Archive ($(echo "$ARCHIVE" | grep -c '^---$')) ==="
echo "$ARCHIVE" | awk '
  /^id: /   { id=$2 }
  /^status:/ { status=$2; gsub(/"/,"",status) }
  /^---$/ && id { printf "  #%-4s  %s\n", id, status; id=""; status="" }
'
echo ""

# Coherence checks
echo "--- Checks ---"

# Extract IDs from both files
IDEAS_IDS=$(echo "$IDEAS" | awk '/^id: /{print $2}')
ARCHIVE_IDS=$(echo "$ARCHIVE" | awk '/^id: /{print $2}')
DUPS=$(comm -12 <(echo "$IDEAS_IDS" | sort) <(echo "$ARCHIVE_IDS" | sort))
if [ -n "$DUPS" ]; then
  echo "FAIL: Duplicate IDs in both files: $(echo "$DUPS" | tr '\n' ' ')"
else
  echo "PASS: No duplicate IDs across files"
fi

TOTAL=$(echo "$IDEAS_IDS $ARCHIVE_IDS" | tr ' ' '\n' | sort -n | uniq -d | wc -l | tr -d ' ')
[ "$TOTAL" -eq 0 ] && echo "PASS: No internal duplicates within a file"

# Check for stalled ideas (awaiting-feedback without workflowInstanceId)
STALLED=$(echo "$IDEAS" | awk '
  /^id:/ { id=$2 }
  /^status: awaiting-feedback/ { status=1 }
  /^---$/ { if (status && !wf) print id; status=0; wf=0 }
  /workflowInstanceId:/ { wf=1 }
  /^---$/ && id { id=""; status=0 }
')
if [ -n "$STALLED" ]; then
  echo "WARN: Ideas awaiting-feedback without workflowInstanceId: $STALLED"
else
  echo "PASS: No stalled ideas"
fi

# Check for raw ideas without body
EMPTY=$(echo "$IDEAS" | awk '
  /^id:/ { id=$2 }
  /^status: raw/ { status=1 }
  /^---$/ { if (status && !body) print id; status=0; body=0 }
  /./ { body=1 }
')
if [ -n "$EMPTY" ]; then
  echo "WARN: Raw ideas with empty body: $EMPTY"
else
  echo "PASS: All raw ideas have body content"
fi

ARCHIVED=$(echo "$ARCHIVE" | awk '/^status:/{gsub(/"/,"",$2); print $2}' | sort -u | tr '\n' ' ')
echo "Archive statuses: $ARCHIVED"
