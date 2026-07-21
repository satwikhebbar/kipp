# Architecture

This directory documents the deployed architecture of Kipp. It is intended to
be read by maintainers and coding agents before making changes that affect
module ownership, runtime boundaries, persistence, external integrations, or
security boundaries.

## Source of truth

[`architecture.yaml`](architecture.yaml) is the canonical, machine-readable
architecture inventory. The Mermaid diagrams in this directory are a readable
projection of that inventory and must agree with it.

The documentation describes the deployed system, not every source file. Do not
update it for cosmetic refactors, file moves, renamed symbols, or test-only
changes that leave responsibilities and dependencies unchanged.

## Contents

- [System and runtime](system.md) — context and Cloudflare runtime containers.
- [Modules](modules.md) — module ownership and dependency direction.
- [Request flows](request-flows.md) — user, scheduled, OAuth, and workflow
  interactions.
- [Data and state](data-and-state.md) — persistent data, lifecycle, and
  security characteristics.
- [Decisions](decisions/) — Architecture Decision Records (ADRs).
- [Update prompt](update-architecture.md) — the repeatable agent workflow for
  detecting and recording architectural drift.

## Change checklist

For a significant pull request, answer the following:

- Is there a new module, runtime service, external dependency, API, schedule,
  queue, or persistence store?
- Has a module's responsibility or dependency direction changed?
- Has a security boundary, authentication flow, secret, or token-handling
  behavior changed?
- Were `architecture.yaml` and the affected diagrams updated?
- Does the trade-off need an ADR?

## Maintenance

Run the [update prompt](update-architecture.md) after a meaningful
architectural change and before opening a pull request. Its output should list
the architecture changes it found, the documentation it changed, and any ADR
decision it made.
