# Zeroshot pilot setup

This directory configures [experiment 1](../../plans/zeroshot-experiment-1-review-loop.md).
Setup simplification: `agent-harness-ektc`. Reviewer-routing rehearsal: `agent-harness-x4w8`.
The reviewer-routing rehearsal passed; implementation execution is tracked on
`agent-harness-vz5`.

The corrected real run (`01a1b08f-1410-7721-9ac5-25d621b6697c`) succeeded in one
pass: all six Lefthook jobs passed and both reviewers accepted. The first run
(`01a1b080-860c-7e00-ab19-6ccdbe20df67`) had been stopped after a reviewer-permission
conflict. See the [run findings](../../plans/zeroshot-experiment-1-review-loop.md#corrected-run-successful).
Correction `agent-harness-hj6z` changes reviewers to `workspace-write` for test
artifacts and passes the mechanical gate summary directly into their inputs.
Source immutability during review is an instruction, not a filesystem boundary.

## Workflow

```text
Worker → Lefthook pre-commit checks → Acceptance review ─┐
                                 └→ Code review ───────┤
                                                       ├ Both accept → Success
                                                       └ Either rejects → Repair
```

Three total passes include the initial implementation and at most two repairs.
Exhaustion fails the run. Explicit error guards follow worker execution, checks,
and reviewer execution. Check failure stops the run; it does not enter repair.
The two reviewers run together after the worker finishes and retain their own
separate conversations across passes. Only the worker edits the source.

## Files

| File | Responsibility |
| --- | --- |
| `review-loop.graph.json` | Stages, role instructions, feedback flow and termination |
| `runtime.json` | Harness/model/session settings and Lefthook command |
| `input.json` | Normal task request and acceptance criteria |
| `validate.sh` | Convenience wrapper for validation without execution |
| `upstream.*.json` | Original v11.1.0 examples for reference |

No custom Python checker, source fingerprint helper, or separate evidence files
are used. A compact check summary goes to the native Zeroshot run log. Script stdout contains
only the JSON result required by Zeroshot; command output is sent to stderr and
retained by the runtime. No generated evidence directory is required.

## Repository checks

The checks step invokes the existing repository hook group:

```bash
rtk pnpm exec lefthook run pre-commit --force --no-auto-install --no-tty
```

`--force` executes the group even when no changes are staged. `--no-auto-install`
prevents this manual invocation from installing hooks. The group in `lefthook.yml`
owns typecheck, lint, docs, tests, integration tests and migration tests. No jobs
are excluded and no test selection is duplicated in the pilot. Future checks added
to this group need no Zeroshot wrapper changes.

A small inline shell adapter in `runtime.json` consumes the script-step input,
executes Lefthook, propagates its exit status and returns a JSON record containing
`passed: true` and a bounded `summary` on success. The summary is bound into both
reviewers' `checkResult` inputs for the current pass; it is never supplied by the task
author or implementation worker. A failed process exits unsuccessfully and cannot
reach the reviewers. The existing execution-error guard enforces this gate.
It keeps only the final 2,000 bytes of command output in the native log, because
verbose test output exceeded Zeroshot’s retained script diagnostic limit. Bash
`pipefail` preserves a failing Lefthook exit status through that output filter.
On failure, rerun the failing hook command for detailed diagnostics; complete verbose
output is not archived by this pilot.
This is specific to the script-step protocol; Zeroshot does not require a file
named `check_step.py` or a helper for every check. Agent-only graphs need no script
adapter, but then check execution relies on agent behavior rather than this gate.

The full forced Lefthook group passed in a native no-model smoke run outside the
desktop sandbox (`01a1b06b-de84-72b2-8d6e-00021f68d793`). Earlier workerd recovery
cases timed out inside the desktop sandbox; no exclusions or timeout increases were
used for this successful full-group run. Its verbose diagnostic output exceeded
the native retention limit, prompting the bounded output tail above. The final native smoke
`01a1b06e-da0c-7b73-adad-9029b76094fa` also passed; its retained log shows all six
hook commands passing. Inline adapter fixtures separately confirmed that exit 7
remains exit 7 through the output filter. Those original smokes used JSON `null`;
the revised adapter fixtures verify the structured success record and failed exit.

## Installed runtime and workspace

- Zeroshot **11.1.0**, pinned under `.zeroshot-pilot/cli/`; global skills were skipped.
- Worktree `.zeroshot-pilot/worktree`, branch `codex/zeroshot-pilot-vz5`.
- Baseline `8c99e7de1f1e88bfa4eae7c8f7db7786ba128d4e`.
- All agents: Codex/OpenAI, `gpt-6.1-sol`, medium effort, `node_instance` sessions.
- Worker and reviewers request `workspace-write`. Reviewers may create test caches
  and temporary artifacts, but their instructions prohibit editing source, tests,
  documentation and dependencies. This is not filesystem-enforced source immutability.
  These use `--config sandbox_mode=...`, supported by both new and resumed Codex turns.
  All use `approval_policy="never"`. The corrected real run exercised these bindings
  successfully; reviewers relied on supplied full-suite results and left reviewed files unchanged.
- Existing Codex ChatGPT login and model admission worked in the real runs.
- Active Memory and postmortem disabled; no delivery nodes, commits or publication.
- The worktree has dependencies but no copied production credentials or local secrets.
- Local Zeroshot does not create a worktree per run. We create it and supply `--cwd`.
  Hosted targets provision their own workspaces; that is a different execution mode.

The graph/runtime are outside the target worktree. Configuration and native state
are under `.zeroshot-pilot/config` and `.zeroshot-pilot/state`, also outside it.
Workspace and active state must remain disjoint. The parent pilot folder is ignored.

## Native graph editor

The graph and runtime are saved as local profile **kipp-pilot**. The running UI is at
[http://127.0.0.1:4185/ui/](http://127.0.0.1:4185/ui/).
Choose Profiles → kipp-pilot to inspect the actual graph, node instructions,
models and loop conditions. Graph JSON exposes the complete underlying definition.
The UI abstracts some control details; inspect error guards in Graph JSON too.
Visual inspection complements the completed routing rehearsal.

The saved profile is a snapshot. After editing the source JSON, refresh it:

```bash
rtk proxy env ZEROSHOT_CONFIG_DIR="$PWD/.zeroshot-pilot/config" \
  .zeroshot-pilot/cli/node_modules/.bin/zeroshot profile set kipp-pilot \
  --graph tools/zeroshot-pilot/review-loop.graph.json \
  --runtime-config tools/zeroshot-pilot/runtime.json
```

Restart the UI with the same config/state directories if needed:

```bash
rtk proxy env \
  ZEROSHOT_CONFIG_DIR="$PWD/.zeroshot-pilot/config" \
  ZEROSHOT_STATE_DIR="$PWD/.zeroshot-pilot/state" \
  .zeroshot-pilot/cli/node_modules/.bin/zeroshot ui --listen 127.0.0.1:4185
```

## Validation and launch

Validate without starting agents:

```bash
rtk proxy bash tools/zeroshot-pilot/validate.sh
```

The deterministic reviewer-routing rehearsal (`agent-harness-x4w8`) passed on
2026-11-06. A temporary fake Codex executable, following the upstream local CLI
test-fixture protocol, returned fixed schema-valid responses through the unchanged
pilot graph. Only the rehearsal runtime replaced model names and the already-tested
Lefthook command with a no-op. No model calls or implementation edits were involved.

| Controlled case | Native run ID | Result |
| --- | --- | --- |
| Both accept | `01a1b07e-6f4a-7a72-9fb8-2b3493dc9c3a` | Success after one pass |
| Acceptance rejects, then accepts | `01a1b07e-db72-7720-a084-49dc0a1cc95d` | Success after two passes |
| Code rejects, then accepts | `01a1b07e-fe77-79b3-b6be-19cecf973c81` | Success after two passes |
| Both reject, then accept | `01a1b07f-2139-7813-a95b-395015eacbc6` | Success after two passes |
| Repeated rejection | `01a1b07f-44a4-74b2-a63e-32c565fc2fc2` | Failed: `review_attempts_exhausted`, exactly three passes |
| Interrupted review | `01a1b07f-7531-7173-aac2-00eb66fe1b6d` | Failed: `review_execution_failed` |

The fixture asserted both previous reviewer messages in each repair-worker input,
exact per-node pass counts, and resumed invocation with the same separate node session
IDs. This verifies graph routing and adapter session selection, not actual model
conversation quality or native sandbox enforcement. Temporary rehearsal state is under
`/tmp/zeroshot-routing-rehearsal`, separate from pilot state. No custom evidence package
is required by the actual run.

The revised rehearsal additionally checks gate-summary delivery into both reviewer
inputs, writable reviewer configuration, and failure before review when the gate
command exits unsuccessfully. Reviewer instructions use the supplied mechanical
result for full-suite verification and run focused checks only for specific concerns.
Neither reviewers nor the worker should duplicate the full Lefthook group.

Revised rehearsal results (2026-11-06, temporary fixture state in
`/tmp/zeroshot-routing-rehearsal-v2`):

| Case | Native run ID | Result |
| --- | --- | --- |
| Both accept | `01a1b08d-e8f4-7032-bce5-6f41b3915591` | One-pass success |
| Acceptance rejects once | `01a1b08e-02d4-7e80-bd89-79d058180f23` | Two-pass success |
| Code rejects once | `01a1b08e-2687-7332-bc47-f4e410218f3b` | Two-pass success |
| Both reject once | `01a1b08e-4887-7042-9be4-4e2afd0ad5b2` | Two-pass success |
| Repeated rejection | `01a1b08e-6b8a-7531-b4df-ce094a7f9501` | Three-pass exhaustion |
| Interrupted review | `01a1b08e-9c66-7ac3-8285-ed272bdd8196` | Review execution failure |
| Failed gate | `01a1b08e-b811-7400-8e72-393ba6e82919` | Check execution failure; zero reviewer calls |

Then recheck the task and clean worktree, claim the implementation issue, record
owner preparation time and launch using the source files:

```bash
rtk proxy env \
  ZEROSHOT_CONFIG_DIR="$PWD/.zeroshot-pilot/config" \
  ZEROSHOT_STATE_DIR="$PWD/.zeroshot-pilot/state" \
  .zeroshot-pilot/cli/node_modules/.bin/zeroshot run \
  --title 'Kipp structured diagnostics pilot' \
  --cwd "$PWD/.zeroshot-pilot/worktree" \
  --graph tools/zeroshot-pilot/review-loop.graph.json \
  --runtime-config tools/zeroshot-pilot/runtime.json \
  --input tools/zeroshot-pilot/input.json --no-environment
```

No delivery flag is used: this custom graph has no delivery nodes.
The desktop sandbox blocked controller IPC during setup; launching the controller
needed scoped escalation. This is separate from the agents' native permissions.
Use the same `ZEROSHOT_*` directories for status, logs and `force-stop RUN_ID`.
Ctrl-C after submission detaches observation rather than stopping execution.

## Sources

- [Release review-loop guide](https://github.com/the-open-engine/zeroshot/blob/v11.1.0/docs/guides/review-loop.md)
- [Release runtime contract](https://github.com/the-open-engine/zeroshot/blob/v11.1.0/docs/reference/runtime-plan.md)
- [Local and hosted workspaces](https://zeroshot.sh/docs/current/concepts/targets/)
- [Native workspace UI](https://zeroshot.sh/docs/current/getting-started/install/#open-the-workspace-ui)
