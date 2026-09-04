#!/usr/bin/env bash
# Run a single live-LLM meal-planning contract scenario.
#
# Usage:
#   bash tools/meal-contract.sh                    # list scenario names
#   bash tools/meal-contract.sh "R03"              # run scenarios matching "R03"
#   bash tools/meal-contract.sh R03 -- --debug      # extra vitest flags after --
#
# Learned the hard way (see test plan "Live-LLM eval" section):
# - .dev.vars stores LLM_API_KEY in quotes; strip them or DeepSeek 401s.
# - One scenario at a time; the full suite runs concurrently and burns quota.
# - EVAL_DEBUG stays ON by default; the transcript dump is the evidence.
# - Run the full suite only as an end-of-iteration gate, never per change.
# - Every run is teed to logs/meal-contract-<timestamp>.log. When a run fails,
#   read that file — do NOT re-run to reproduce; re-running burns a live session.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f ".dev.vars" ]; then
  echo "Error: .dev.vars not found." >&2
  exit 1
fi

LIVE_PROVIDER="${LIVE_PROVIDER:-deepseek}"
case "$LIVE_PROVIDER" in
  openrouter) API_KEY_NAME="OPENROUTER_API_KEY" ;;
  gemini) API_KEY_NAME="GEMINI_API_KEY" ;;
  deepseek) API_KEY_NAME="DEEPSEEK_API_KEY" ;;
  *) echo "Error: unsupported LIVE_PROVIDER: $LIVE_PROVIDER" >&2; exit 1 ;;
esac

API_KEY=$(grep "^${API_KEY_NAME}=" .dev.vars | cut -d '=' -f2- | tr -d ' "' | tr -d "\r")

if [ -z "$API_KEY" ]; then
  echo "Error: $API_KEY_NAME not found in .dev.vars" >&2
  exit 1
fi

FILTER="${1:-}"
shift || true

if [ -z "$FILTER" ]; then
  echo "Live contractIt scenarios (run one with: bash tools/meal-contract.sh \"<fragment>\")"
  perl -0777 -ne 'while (/contractIt\(\s*"([^"]*)"/g) { print "$1\n" }' \
    src/__contract__/deepseek-meal-planning.contract.test.ts | sort
  exit 0
fi

mkdir -p logs
RUN_ID="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="logs/meal-contract-${RUN_ID}.log"
TRACE_FILE="logs/meal-contract-${RUN_ID}.provider-trace.ndjson"

export "$API_KEY_NAME=$API_KEY"
env LIVE_CONTRACT=1 LIVE_PROVIDER="$LIVE_PROVIDER" EVAL_TRACE_PATH="$TRACE_FILE" pnpm exec vitest run \
  -t "$FILTER" "$@" src/__contract__/deepseek-meal-planning.contract.test.ts 2>&1 |
  tee "$LOG_FILE"

echo "Provider turn trace: $TRACE_FILE"
