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

## Agent-facing content — declare *what*, never *how*

Prompts, skills, and tools are three layers of one contract: content states the **requirement**, the runtime resolves the **mechanism**. Collapsing the two freezes one environment's shape into content that outlives it — and content is the layer that cannot be typechecked, so the mismatch surfaces as a failed analysis rather than a failed build.

| Layer | Owns | Must never |
|-|-|-|
| **Skill** (`skills/`) | What the work needs: the dataset by name, and its contract — key columns, identifier space, organism | Name a path, directory, filename, or format — **or the tool that locates one** |
| **System prompt** (`harness/src/prompts/`) | Which tools exist and when to reach for one | Enumerate specific datasets, or promise a format the catalog doesn't guarantee |
| **Tool** (`harness/src/tools/`) | Turning a described need into a concrete path, with enough metadata to choose between candidates | Require the caller to already know where a thing lives |

The rules that follow from it:

- **A skill states the task; the tool describes itself.** Say "screen these identifiers against the safety panel" or "resolve the network from the reference inventory" — not `check_safety_panel`, not `list_available_refs`. **A tool carries its own `description` into context when it is attached to an agent**, so the agent already knows what it holds and what each one is for. The skill's job is to say what needs doing; the agent binds that to a tool. Naming the identifier therefore adds nothing the agent lacks, and quietly couples shared content to one host's inventory — `skills/` is loaded by the OSS host and by managed deployments alike. It is unverified by construction: `validateAgentSkills` reads only whether each declared `SKILL.md` is readable, never its prose, so a renamed, unwired, or invented tool name stays green until an agent tries the call. That gap is not a missing check to build — the guard is review against this document, which is why the rule has to hold on the way in.
- **A capability is not always a file.** Before telling a skill to resolve something, confirm it is actually staged on disk. Data that ships inside the agent runtime and is served only through a tool has no path in any environment, so instructing an agent to go find it is the same failure as naming a stale one. Say it is a lookup, and say how to get its output into a script.
- **Dataset names are not paths.** "CollecTRI", "MSigDB hallmark", "SILVA" are domain vocabulary and belong in skills. The ban is on locations and formats, not on naming the thing you need.
- **Describe data well enough to be found by meaning.** This is what makes the rest survivable: an agent told "you need TF-target regulons" can only recognise `CollecTRI_regulons.csv` if something says what that file holds. That is the job of `format`/`contents`/`organism` in `harness/src/reference-data/catalog.ts` — a new dataset without a real `contents` description is effectively invisible.
- **Absence is a normal state, not an error.** Say what to do when a resource is missing — report it and proceed with what exists. Never substitute silently, never invent a path.

Layout is an installer detail. Anything that encodes it has made a private decision into a public interface.

## Working here

- Pick the subsystem, `cd` into it, then use its scripts (`bun install`, `bun run dev`, …). The root has none.
- Each subsystem owns its conventions in its own `CLAUDE.md`; there is no shared root convention set.
- Product orientation for users is [`README.md`](./README.md); the repository domain map is [`CONTEXT.md`](./CONTEXT.md).

## Specs (OpenSpec)

Each subsystem owns its own OpenSpec specs — `cli/openspec/specs` and `harness/openspec/specs`. There is no root-level spec set, and `harness` has **no** separate `docs/adr`: its design decisions live in its specs. When changing a subsystem, run the `openspec` CLI inside that subsystem's dir (e.g. `cd harness && openspec …`) so the change lands in the right spec tree. `AGENTS.md` is a symlink alias of `CLAUDE.md` at every level — same file, two names.
