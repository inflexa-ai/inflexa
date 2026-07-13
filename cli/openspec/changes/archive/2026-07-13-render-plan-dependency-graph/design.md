# Design — plan dependency graph (CLI)

Grounded in a throwaway spike (rendered real plans at multiple widths, probed
opentui's handling of the candidate library, and prototyped the hand-rolled
renderer). The decisions below record what that spike settled.

## Decision 1 — hand-roll the renderer; take no new dependency

**Considered:** `beautiful-mermaid` (`plan → mermaid → renderMermaidASCII`),
which is MIT, synchronous, and renders cleanly.

**Rejected because** its published bundle statically imports
`elkjs/lib/elk.bundled.js` (~7.7 MB) at the top of its single entry module.
`elkjs` is the graph-layout engine used only by the SVG path; the ASCII
renderer never executes it, but a static default import is exactly what a
bundler cannot safely tree-shake. That is ~10 MB of install and a non-trivial
supply-carbon footprint for a terminal feature a small pure function covers.

**Chosen:** a ~150-line renderer in `src/modules/harness/plan_dag.ts`. The hard
part of graph layout — assigning depth — is the topological level the plan
already implies (`depends_on`), the same computation the harness scheduler runs
(`computeTopologicalLevels`). The spike showed the hand-rolled output matching
the tuned library at the same height, dependency-free.

**Accepted trade-off:** we own layout quality. General 2D edge routing is hard;
we keep plans readable by targeting the common shape (mostly-adjacent
dependency tiers) and truncating/scrolling rather than attempting perfect
routing of arbitrary long-range edges.

## Decision 2 — the layout algorithm

- **Depth** = longest-path level from the roots. Steps at the same level are
  dependency-independent (they render in one row); this is structure, not a
  schedule (see Decision 4).
- **Box per step**, single content line `id name`, with interior horizontal
  padding (2 cols) and a connector gap row — enough breathing room without the
  library's default doubled-height airiness.
- **Edges** are drawn on a **direction-bitmask grid** (U/D/L/R bits per cell),
  then each connector cell resolves to its box-drawing glyph
  (`│ ─ ┌ ┐ └ ┘ ┬ ┴ ├ ┤ ┼`). Per-parent directional segments (rather than a
  blanket horizontal span) keep single-parent edges straight and multi-parent
  merges crisp — the spike's junction artifacts came from omitting this.
- **Truncation:** step-name labels clamp (~24 chars, `…`); the full name lives
  in the step detail. **Width:** parallel track count — not label length —
  drives width, so truncation cannot shrink a wide fan-out; the card body
  scrolls horizontally instead (the layout postmortems' size-dependent overlap
  rules apply — sweep `testRender` widths).

## Decision 3 — render through `<text>`, not custom drawing

The renderer produces a multi-line **string**; the block hands it to a `<text>`
renderable. opentui does no custom cell drawing, so the stream-block invariant
("each block maps to a built-in renderable") holds — the "drawing" is string
composition in TypeScript, verifiable in isolation without a renderer.

## Decision 4 — dependency structure, never an execution schedule

The harness resource-budget scheduler admits a dependency-satisfied step only
when `sum(inFlight) + step ≤ budget`, with skip-over — so two independent
steps at the same tier can be **serialized**. The plan card must not imply
otherwise:

- Side-by-side boxes assert independence (no edge), which is scheduling-invariant.
- No "waves / ready → then" framing (an earlier prototype) — it implied
  batches that run together, which the budget can break apart.
- The plan card carries **no run status**. Live execution state belongs to the
  sticky `RunProgressRow`, which reads the durable run and step ledgers and can
  therefore show one dependency-independent step `running` while another remains
  `queued`. That landed surface is **out of scope** here. Correlating its execution
  rows back onto the immutable plan graph would create a second status surface and
  a second authority for run state.

## Decision 5 — interactivity via a picker, not spatial navigation

The chat stream is not a focusable per-node surface: openables are reached with
the `o` binding (latest) and a `SelectDialog` picker (the rest), not a cursor
moving over glyphs. Spatial navigation over a 2-D ASCII grid would be a bespoke
focus/hit-test system at odds with that model.

**Chosen:** an "Explore plan steps…" command opens a `SelectDialog` over the
latest plan's steps (id · name · agent); selecting one opens a **step-detail
dialog**. This reuses `select_dialog` + a detail render and needs no new focus
machinery — the direct parallel to "Browse artifacts…".

**Step detail carries:** `question`, `acceptance_criteria`, `constraints`,
`caveats`, `resources` (cpu · memGb · gpu), `agent`, `depends_on`. These are
already on the wire `PlanStepSchema`; `readPlanCard` is extended to extract them
as **primitives, copy-on-receive** (never a harness object) — the same
discipline the other card readers follow. No harness round-trip: a step is
inline data, not a resolvable external artifact, so it opens a dialog rather
than going through path resolution.

## Decision 6 — the boundary (resolves the prior open question)

`planToDag` lives in the CLI. The managed deployment renders its **own** plan
view from the same `data-plan` contract, so the harness owes no canonical
diagram serialization — that would be speculative surface for a second host
that draws its own way regardless. If a future host ever wants to share the
CLI's exact ASCII, the pure function lifts then; until then it stays CLI-local.

## Failure & edge behavior

- Empty/absent `steps` → render nothing extra; fall back to the flat step list.
- Renderer throws (guarded by `Result`) → fall back to the flat step list.
- A cycle (should be impossible — plans are validated acyclic upstream) → the
  level computation breaks ties defensively (treat back-edge as level 0) rather
  than looping; the graph still renders.
- Unknown `depends_on` id (references a step not in the card) → the edge is
  skipped, not drawn to nowhere.
