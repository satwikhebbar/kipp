# `/update-architecture` prompt

Use this prompt when a change may affect Kipp's architecture. It is designed
for a coding agent working in this repository.

```text
Update Kipp's architecture documentation for the current repository state.

1. Read all files under docs/architecture/, including architecture.yaml and ADRs.
2. Inspect the current diff and the relevant source code, especially src/index.ts,
   src/linkedin/workflow.ts, src/linkedin/ideas/, src/core/idea-ingest.ts,
   src/triggers/, src/integrations/, src/providers/, src/agent/, src/runtime/,
   src/calendar/, src/core/token-vault.ts, src/core/token-vault-client.ts,
   src/core/types.ts, and both Wrangler configurations.
3. Identify only material architectural changes: a new or removed module,
   runtime component, external system, persistence store, API, schedule, security
   boundary, module responsibility, or dependency direction.
4. Do not change architecture documentation for cosmetic refactors, file moves,
   renamed symbols, formatting, or tests that do not alter those concerns.
5. When drift exists, update architecture.yaml first. Then update only the
   affected Markdown explanations and Mermaid diagrams so they agree with it.
6. Create a new ADR in docs/architecture/decisions/ only when the change records
   a durable, consequential trade-off. Do not create an ADR just to narrate an
   implementation detail.
7. Validate every Mermaid diagram for clear labels and every YAML edit for
   consistency with the source code. Do not put secrets, access tokens, personal
   data, or private repository contents in documentation.
8. Report: (a) architectural changes detected, (b) files updated, (c) ADRs
   created or deliberately not needed, and (d) any uncertainty or follow-up.
```

The prompt is intentionally tool-agnostic. It can be used in Codex or another
coding agent without making the documentation depend on a vendor-specific
runtime. Future CI can validate `architecture.yaml` and generate selected
Mermaid blocks from it.
