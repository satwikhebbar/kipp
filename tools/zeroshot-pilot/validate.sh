#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ZEROSHOT_CONFIG_DIR="$root/.zeroshot-pilot/config"
export ZEROSHOT_STATE_DIR="$root/.zeroshot-pilot/state"
exec rtk proxy "$root/.zeroshot-pilot/cli/node_modules/.bin/zeroshot" run \
  --title "Kipp structured diagnostics: implementation and review pilot" \
  --cwd "$root/.zeroshot-pilot/worktree" \
  --graph "$root/tools/zeroshot-pilot/review-loop.graph.json" \
  --runtime-config "$root/tools/zeroshot-pilot/runtime.json" \
  --input "$root/tools/zeroshot-pilot/input.json" \
  --no-environment --validate-only
