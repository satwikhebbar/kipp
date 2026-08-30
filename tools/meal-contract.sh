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
  echo "Error: .dev.vars not found. Add LLM_API_KEY=... (may be quoted)." >&2
  exit 1
fi

LLM_API_KEY=$(grep '^LLM_API_KEY' .dev.vars | cut -d '=' -f2- | tr -d ' "' | tr -d "\r")

if [ -z "$LLM_API_KEY" ]; then
  echo "Error: LLM_API_KEY not found in .dev.vars" >&2
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

DEEPSEEK_CONTRACT=1 LLM_API_KEY="$LLM_API_KEY" pnpm exec vitest run \
  -t "$FILTER" "$@" src/__contract__/deepseek-meal-planning.contract.test.ts 2>&1 |
  tee "logs/meal-contract-$(date +%Y%m%d-%H%M%S).log"
