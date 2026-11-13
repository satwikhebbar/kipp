# Zeroshot autonomy trials for Kipp

Research date: 6 November 2026. Tracking: `agent-harness-5tzh`.

## Recommendation

Start with one local, bounded implementation of `agent-harness-vz5` (structured meal-context extraction logs). Measure human intervention and accepted correctness, then evaluate whether a reusable review graph reduces coordination work. Treat planner optimization as a later, controlled experiment.

This is a research recommendation, not an installation or execution report. No Zeroshot run, paid evaluation, deployment, commit, or external publication was performed.

## What Zeroshot provides

Zeroshot is an open-source workflow engine around coding harnesses. A graph defines typed state and control flow, a runtime plan selects harnesses/models/connections, and caller input describes the task. Templates include `single-worker`, `software-change`, and `auto-research`; execution can be local, self-hosted, or managed. These are development workflows, separate from Kipp's deployed Telegram workflows. `/current/` follows main and can describe unreleased functionality: choose an installed release and its matching documentation before adopting commands. [Overview](https://zeroshot.sh/docs/current/)

The documented review graph runs a worker followed by independent acceptance and code reviewers, feeds rejection diagnostics back to the worker, and stops at acceptance or its iteration bound. Runtime bindings can use different harnesses/providers per role. Reviewers share the workspace; their no-edit behavior is an instruction, not a filesystem isolation boundary. The example has four passes; that is an example configuration rather than a universal product limit. [Review-loop guide](https://zeroshot.sh/docs/current/guides/review-loop/)

Local Codex execution reuses the installed CLI's login/configuration. Docker and managed execution instead require credentials such as `OPENAI_API_KEY`. The first-run guide supports caller JSON containing a `task`, validation without agent execution, and `--delivery none`; the software-change template otherwise defaults to PR delivery. [First run](https://zeroshot.sh/docs/current/getting-started/first-run/)

The UI provides node transcripts and timeline replay. Runs persist when the observer disconnects; Ctrl-C detaches observation. Status/log streams, explicit force-stop, and failed-run recovery are available. Checkpoint restoration can replace later edits, including ignored/untracked files, reinforcing the need for a dedicated trial workspace. [Observation and recovery](https://zeroshot.sh/docs/current/guides/observe-and-control/)

Planning skills convert goals into checkable acceptance criteria and constraints. Plans can carry an existing tracker key, and the run/issue retains execution status. A plan file should be an execution specification linked to Beads, not a competing task tracker. [Planning guide](https://zeroshot.sh/docs/current/guides/planning/)

Active Memory offers cross-run lessons and enables a model-backed postmortem by default. Disable both memory scopes and the postmortem during the initial comparison so changing context and auxiliary model usage do not confuse the result; keep durable project policy in Beads and repository instructions. [Active Memory](https://zeroshot.sh/docs/current/guides/active-memory/)

Installation uses `@the-open-engine-company/zeroshot`; the executable is Rust, delivered through npm. The installer also installs global agent skills unless `ZEROSHOT_SKIP_SKILLS=1` is set. Local builds include contributed OpenCode support; verify the installed adapter's provider matrix rather than assuming identical support across harnesses. [Installation](https://zeroshot.sh/docs/current/getting-started/install/)

## Why this project is a reasonable fit

Repository evidence:

- `docs/architecture/system.md`: Calendar, LinkedIn, and meal planning share a bounded agent runtime while retaining domain policy and deterministic mutation authority.
- `package.json`: `pnpm check` runs lint, source documentation requirements, typechecking, and standard Vitest tests. `pnpm test:integration` is a separate gate; `vitest.config.ts` excludes integration tests.
- `src/__tests__/`, `src/__integration__/`, `src/__contract__/`: existing fast, fake-service, and opt-in provider-backed verification layers.
- `AGENTS.md`: Beads is authoritative; conservative policy requires explicit authority for commits, pushes, and remote sync.
- Installed TARS skills `issue-kickoff` and `handoff-review`: author/reviewer routing already exists. Zeroshot's incremental value must be measured against that process, particularly automatic retry routing and durable run evidence.
- `docs/production-runtime-configuration.md`: production values live in Dashboard; structural deployment configuration and the runtime-variable contract are tracked. Production provisioning is a separate completion boundary.

Backlog freshness is a practical constraint. Open issues for prior-plan provisional leakage, singular/plural ingredients, and Calendar cancellation already have relevant implementations and regression coverage in the checkout. This does not prove all acceptance criteria are complete; it does make them poor blind first implementation assignments.

## Three trials

### 1. Finish a small issue without supervision

**Candidate:** `agent-harness-vz5`, structured extraction diagnostics. Verified source gap: `src/meal-planning/agent-workflow.ts` currently joins inventory changes and exception summaries into comma-separated strings. `src/runtime/logging.ts` only permits primitive `details` values.

**Assignment:** retain extraction behavior and wire schemas; emit available/unavailable ingredient arrays and safe structured exception summaries; make no-op arrays explicit; exclude free-form instructions and quantity notes. Resolve the shared logging type deliberately without weakening its metadata-only contract. Extend existing meaningful regression tests and document the event shape.

**Verification:** focused meal-workflow/logging checks, `pnpm check`, and relevant fake-service integration coverage. Review both populated and no-op events, privacy omissions, and unchanged workflow behavior. No live provider or bot is needed.

**Question answered:** can it finish a concrete cross-file change and repair review findings while you are away?

**Record:** human interventions after launch, time spent preparing/reviewing, elapsed time, provider usage if reported, review passes, and defects found in final human review. A useful result is accepted behavior with no mid-run intervention; passing agent review alone is insufficient.

### 2. Automate the coordination in an author/reviewer lane

**Candidate:** the next small, agreed Kipp change, preferably after trial 1 establishes a baseline.

**Graph:** worker → parallel acceptance and code review → bounded repair → terminal result. Acceptance review checks issue criteria and actual test evidence; code review checks architectural boundaries, idempotency, privacy, and maintainability. Begin with the same model family to reduce setup variables; cross-provider review is a separate experiment.

**Integration:** one coordinator claims the Beads issue and supplies its description, acceptance criteria, relevant paths, and repository constraints as input. The run returns a diff, test evidence, and verdicts; the coordinator updates Beads after inspecting them. Do not have TARS and Zeroshot both control the same repair cycle. Keep publication outside the initial graph.

**Question answered:** does routing work and repair automatically save more attention than the existing TARS handoff process?

**Record:** coordinator touches, review findings accepted as useful, redundant or conflicting feedback, pass count, and remaining human review work. Compare similar tasks or disposable runs from the same baseline, rather than treating one anecdote as proof.

### 3. Improve one planner property through controlled experiments

**Candidate:** a narrowed slice of `agent-harness-0y2`, planner payload size/latency. First verify what remains unresolved; its issue description is historical evidence, not a current benchmark.

**Assignment:** establish a reproducible baseline; try one prompt/catalog compaction; preserve evaluator-relevant fields, tool contracts, and behavior on existing deterministic cases. Record request size, checks, and limitations. Smaller payload is a proxy and does not itself prove improved provider latency or plan quality.

**Verification discipline:** use existing suites and corpus; do not create throwaway test scripts. Follow the stored meal-planning discipline: diagnose with transcripts, fix semantics in the fast layer, then one selected live confirmation. Keep paid live execution outside the autonomous retry loop. Do not launch the default ten-round research template against live meal planning. An explicitly bounded custom graph is a better initial fit. Even a one-round research setting is not a tight call budget: the current direct execution documentation describes five model executions in an ordinary round and correction passes within a round. Check the installed version's actual graph. [Execution templates](https://zeroshot.sh/docs/current/concepts/execution/)

**Question answered:** can the engine produce reproducible, evidence-backed improvement rather than merely repeat model calls?

## Practical first setup

Use a clean disposable worktree, install project dependencies, and leave this checkout's existing untracked research files untouched. Local execution edits the folder selected by `--cwd`; it does not automatically isolate the current working tree. Pure test trials do not need `.dev.vars`, the Telegram webhook, or production access. If later testing Wrangler, account for per-worktree local configuration/D1 state and the single-webhook-per-bot constraint in `README.md`.

After installing a release and checking its matching help/docs, prepare external `input.json` and `runtime.json` files. The former contains the agreed task and constraints; the latter selects an installed harness and accepted model identifier:

```json
{
  "harness": "codex",
  "provider": "openai",
  "model": "YOUR_MODEL_ID",
  "effort": "high",
  "activeMemory": { "repository": false, "graph": false },
  "globalAgents": { "postmortem": { "enabled": false } }
}
```

Illustrative validation command, not executed here:

```sh
rtk proxy zeroshot run --cwd /absolute/path/to/disposable-kipp-worktree --title "Kipp structured extraction logs" --template software-change --delivery none --input /absolute/path/to/input.json --uniform-runtime-config /absolute/path/to/runtime.json --validate-only
```

Remove `--validate-only` to launch after selecting a compatible release. Explicit task instructions should preserve the repository's no-commit/no-push policy; `--delivery none` disables graph delivery and is not a tool permission sandbox. Author custom iteration/attempt bounds if the built-in template does not fit the intended trial. Do not invent a monetary-budget flag or equate a model size setting with a spending cap.

Start with trial 1, then trial 2 if final human review confirms the result. Trial 3 is most informative when planner reliability or latency is the primary source of supervision. No operational configuration is needed to decide which question matters most.
