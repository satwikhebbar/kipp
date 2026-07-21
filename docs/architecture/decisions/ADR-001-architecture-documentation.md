# ADR-001: Maintain architecture as Markdown, Mermaid, and YAML

- Status: Accepted
- Date: 2026-07-21

## Context

Kipp's Worker, Workflow, Durable Object, and external integrations are spread
across several modules. Their relationships were previously discoverable only
by reading implementation code. A manually maintained image would be difficult
to review and likely to drift.

## Decision

Maintain architecture documentation in `docs/architecture/`:

- `architecture.yaml` is the canonical machine-readable architecture inventory.
- Markdown explains runtime boundaries, module ownership, request flows, and
  persistent state.
- Mermaid diagrams are stored directly in Markdown and must match the YAML
  inventory.
- The repeatable `update-architecture.md` prompt directs coding agents to
  inspect changes, update the model and affected diagrams, and report drift.

## Consequences

Documentation changes are reviewable in Git and render natively on GitHub.
Maintainers must update the YAML and diagrams for material architectural changes.
The repository deliberately does not introduce diagram-generation tooling yet;
the YAML model establishes a stable input for future validation or generation.
