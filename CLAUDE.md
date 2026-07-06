# CLAUDE.md

The open-source Inflexa product monorepo — a set of **independent subsystems**, each self-contained with its own dependencies, tooling, and documentation. There is no root build, package manager, or task runner: **work inside the subsystem you are changing** (`cd cli`, `cd harness`, …) and read that subsystem's own `CLAUDE.md` first. This file is only a map.

## Subsystems

| Directory | What it is | Read first |
|-|-|-|
| `cli/` | Local-first TUI/CLI — the user-facing product. SQLite storage, auth, the local model proxy, the opentui chat app. | `cli/CLAUDE.md`, `cli/CONTEXT.md` |
| `harness/` | `@inflexa-ai/harness` — the host-agnostic agent harness: agent loop, DBOS-durable workflows, sandbox protocol, providers. | `harness/CLAUDE.md`, `harness/CONTEXT.md` |
| `skills/` | Shared bioinformatics skill packs the agent loads at runtime. | — |
| `templates/` | Report-rendering templates (e.g. `report-html`). | — |
| `images/sandbox-base/` | The sandbox Docker image, its Go `sandbox-server`, and the provenance hooks. | `images/sandbox-base/` |

## How the pieces relate

`cli` and `harness` are **fully independent packages** — each owns its `package.json`, lockfile, and `node_modules`. `cli` is the *embedder*: it consumes `harness` as `@inflexa-ai/harness` (via `file:../harness`, or a published version) and wires the harness's capability seams to trivial local realizations. Nothing else crosses a subsystem boundary except the shared `skills/` and `templates/` content, which `harness` reads at runtime (`skillsDir` / `templatesDir`) — kept at the root precisely so both the OSS host and a managed deployment can load the same content.

**Design rule for the boundary**: the harness is the product core and is designed from its own point of view — its capabilities, concepts, and configuration surface are harness-owned and host-agnostic, meaning the same thing under the CLI or a managed deployment. An embedder is a consumer: it supplies values at its composition root (configuration, policies, seam realizations) and never owns or redefines what the harness does. Design new capabilities harness-first, then wire them from the embedder — never as an embedder feature the harness happens to honor.

## Working here

- Pick the subsystem, `cd` into it, then use its scripts (`bun install`, `bun run dev`, …). The root has none.
- Each subsystem owns its conventions in its own `CLAUDE.md`; there is no shared root convention set.
- Product orientation for users is [`README.md`](./README.md); the repository domain map is [`CONTEXT.md`](./CONTEXT.md).

## Specs (OpenSpec)

Each subsystem owns its own OpenSpec specs — `cli/openspec/specs` and `harness/openspec/specs`. There is no root-level spec set, and `harness` has **no** separate `docs/adr`: its design decisions live in its specs. When changing a subsystem, run the `openspec` CLI inside that subsystem's dir (e.g. `cd harness && openspec …`) so the change lands in the right spec tree. `AGENTS.md` is a symlink alias of `CLAUDE.md` at every level — same file, two names.
