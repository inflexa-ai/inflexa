# Proposal — render the plan card as a dependency graph (CLI side)

## Why

The plan card is the moment a user first sees the shape of the analysis the
agent proposed — but the CLI renders it as a flat list of `id name [agent]`
lines. A plan is a **DAG**: steps declare `depends_on`, tracks run
independently, and results converge. That structure — the single most useful
thing about a plan — is invisible today. The dependency edges already ride the
wire part (`data-plan` carries full `PlanStepSchema` steps, `depends_on`
included); the CLI simply drops them: `readPlanCard` strips each step to
`{id, name, agent}`.

This is a CLI-owned concern. The harness ships the plan's structure over its
contract; **how** a host draws it is the host's business — a managed deployment
renders its own plan view from the same contract. So this change adds no
harness surface and lives entirely in the CLI's presentation layer.

## What Changes

- **The plan-card block renders a dependency graph, not a list.** A hand-rolled
  ASCII renderer lays steps out by topological depth (longest-path level),
  draws one box per step, and connects `depends_on` edges through a
  connector band whose junctions resolve to crisp box-drawing glyphs. The
  string is handed to a `<text>` renderable — no custom cell drawing at the
  opentui layer, consistent with the stream-block rules.
- **No new dependency.** The obvious library (`beautiful-mermaid`) statically
  imports `elkjs` (~7.7 MB, an SVG-only layout engine the ASCII path never
  executes) — dead weight for a terminal feature. A ~150-line renderer over the
  topological levels the plan already implies matches its output and stays ours
  to evolve.
- **The graph shows dependency structure, never an execution schedule.** Two
  boxes side by side mean "neither depends on the other" — a fact invariant
  under scheduling. It does **not** claim they run concurrently: the harness
  resource-budget scheduler may serialize independent steps. The plan card
  therefore carries no run status; live execution state stays on the sticky
  `RunProgressRow`, backed by the durable run and step ledgers (out of scope here).
- **Steps are openable for detail.** The chat stream is not a spatially
  focusable surface (openables are reached via `o`/a picker, not a cursor), so
  an "Explore plan steps…" command opens a `SelectDialog` over the latest
  plan's steps; choosing one opens a detail view surfacing the fields the card
  omits — `question`, `acceptance_criteria`, `constraints`, `caveats`,
  `resources`, and `depends_on`. Mirrors the existing "Browse artifacts…" flow.
- **Graceful degradation.** Rendering is wrapped in a `Result`; an empty/absent
  `steps` array or any render failure falls back to today's flat step list. A
  plan wider than the card scrolls horizontally; long labels truncate (full
  name in the step detail).
- **REPL parity.** The shared renderer feeds the REPL printer too, so
  `chat_printer.ts` prints the same dependency graph as plain text instead of
  bare per-step lines.

## Capabilities

### Modified Capabilities

- `tui-stream-blocks`: the plan-card block renders a hand-rolled ASCII
  dependency graph with openable per-step detail; the card carries the extra
  primitive step fields the graph and detail need. New gallery exhibits.
- `command-palette`: an "Explore plan steps…" command opens a step picker over
  the latest plan, then a step-detail dialog.
- `chat-command`: the REPL printer renders the plan as the same dependency
  graph (plain text) rather than per-step lines.

## Impact

- `src/tui/components/plan_card_block.tsx` (renders the graph, not the list)
- New shared pure renderer `src/modules/harness/plan_dag.ts`
  (steps → ASCII; two callers: the block and the REPL printer)
- `src/modules/harness/chat_printer.ts` (`readPlanCard` carries `depends_on`
  + detail fields; REPL printer uses the shared renderer)
- `src/types/session.ts` (`PlanCardStepView` gains the carried primitive fields)
- `src/tui/commands.tsx` + keymap ("Explore plan steps…" command)
- A step-detail dialog (reusing `SelectDialog` + a detail render) and its
  design-gallery exhibits; `src/tui/layout/design_gallery.tsx`
- No new package dependencies; no harness change
