# tui-stream-blocks Specification

## Purpose
TBD - created by archiving change inflexa-design-system. Update Purpose after archive.
## Requirements
### Requirement: Eight canonical stream-block states

The chat stream SHALL render the eight canonical block states of the design system, each as a gutter-marked block sharing the fixed 2-cell gutter (`size.gutter`) so only the marker glyph and its role color change between blocks:

1. **welcome / startup** — shown at the top of an empty stream; a wordmark plus the active context (greeting, anchor path with ✓/⚠ badge, resume hint, command hint).
2. **plain chat turn** — the existing user/assistant `MessageBlock` (markdown body under a `>`/`<` marker).
3. **thinking / reasoning** — a `◆ thinking` marker, an optional duration, and a collapsed-by-default italic reasoning body that can expand.
4. **tool call & result** — a `▸` marker with the tool/verb name and target, and the call's status (ok / running / error, with duration); for a call without a rendered result the status sits inline on the name line (see "Tool status placement is prop-controlled"), and for a call with a result the result renders in a `<code>` block with the status as a completion line beneath it.
5. **long-running run / task** — a `●` marker with the run name, a progress bar, and an indented step list (done / running / queued).
6. **diff / file edit** — a `✎` marker with the file name and +/− counts, the hunk rendered via the `<diff>` renderable, and accept/reject/edit affordances.
7. **error / abort** — a `✗` marker, the abort/error summary, and a bordered callout (using `stroke.danger` chrome and `onAccent` foreground on any filled region); the degraded-anchor case (`markerWritten = false`) renders its callout from existing anchor state.
8. **command palette** — the existing `^K` palette overlay.

Each block SHALL map to a single built-in opentui renderable (no custom drawing), read all colors via `theme().<role>`, all non-ASCII glyphs via `GLYPHS`, and all spacing/dimension/stroke via the design tokens. Markers SHALL come from the shared marker set (`MARKERS`) in `src/lib/design_system.ts`.

#### Scenario: Blocks share the fixed gutter

- **WHEN** any two block types render consecutively in the stream
- **THEN** their content aligns in the same gutter column (`size.gutter`) and only the marker glyph and its color differ

#### Scenario: Each block uses a built-in renderable

- **WHEN** a block renders code, a diff, a wordmark, or text
- **THEN** it uses `<code>`, `<diff>`, `<ascii_font>`, or `<text>`/`<box>` respectively — no custom cell drawing

#### Scenario: No inlined hex or glyph literals

- **WHEN** a block paints a color or prints a non-ASCII glyph
- **THEN** the color comes from `theme()` and the glyph from `GLYPHS`, never an inline literal

### Requirement: Tool status placement is prop-controlled

`ToolBlock` SHALL take an `inlineStatus?: boolean` prop controlling where the call's status (glyph + label + optional duration) renders: inline on the name line — after the name and target, separated by a `space.md` gap — or as a standalone completion line below the block's content. The default SHALL derive from the result: a block without a `result` renders inline (live harness tool events never carry a result, so every live call uses the single-line form), and a block with a `result` keeps the completion line below the `<code>` panel, where an inline status would strand the outcome above the output it describes. An explicit prop value SHALL override the derivation (the design gallery pins both forms). The inline form SHALL NOT right-align the status (a wrapped right-aligned segment lands at column 0 and breaks the gutter); it flows after the name so narrow terminals soft-wrap it instead. Both placements SHALL be pinned by frame-assertion render tests, including a sidebar-open-width (40-column) sweep.

#### Scenario: Live tool call renders on one line

- **WHEN** a tool call without a result renders (running or finished)
- **THEN** the name, target, and status share one line — `▸ name target  ✓ ok · 14ms` — with a `space.md` gap before the status

#### Scenario: A result keeps the completion line

- **WHEN** a tool block renders with a `result`
- **THEN** the result renders in the `<code>` panel and the status renders as a completion line beneath it, as before

#### Scenario: The gallery pins both placements

- **WHEN** the design gallery renders the tool-block exhibits
- **THEN** it shows the inline form and the completion-line form via explicit `inlineStatus` values

### Requirement: Message block renders all part kinds exhaustively

`MessageBlock` SHALL render an assistant turn's parts by switching on the part discriminant
(`part.type`) for each kind in the extended `Part` union — text, thinking, tool-call, file-edit,
plan-card, run-card, presentation, openable-card — delegating to the matching block renderer. The
harness-sourced kinds render live data: the tool-call block renders real tool activity (name,
running/finished/error outcome, duration), and the run-card block renders run id, title, and step
count (the fields the harness contract carries — it has no run-status field). The plan-card block
renders plan id, title, and a hand-rolled ASCII dependency graph of its steps — steps laid out by
topological depth, one box per step, edges drawn from each step's `depends_on` — composed as a
string and rendered through a `<text>` renderable (no custom cell drawing); it falls back to a flat
per-step list when `steps` is empty/absent or graph rendering fails (a `Result`), and its steps are
openable to a detail view. The graph SHALL depict dependency structure only and SHALL carry no run
status: independent steps drawn side by side assert that neither depends on the other, never that
they run concurrently (the harness resource-budget scheduler may serialize them). The presentation block renders text-shaped
`show_user` content inline through the existing `<markdown>` renderable (`markdown` bodies
directly; `code` as a fenced block; `table` as a markdown table). The openable-card block renders
pixel-shaped content as a card: optional title, one row per entry (type glyph from `GLYPHS`, name,
optional caption), the resolved path, and a degraded state for missing entries. Card parts carry
only primitive fields extracted at receipt, never harness objects — the plan-card part carries each
step's `id`, `name`, `agent`, `depends_on`, and the detail fields (`question`,
`acceptance_criteria`, `constraints`, `caveats`, `resources`, `track`, `step_type`), each deep-copied
at receipt. A conversation part with no
dedicated renderer SHALL render a one-line tagged mention (observed, not silently swallowed). The
switch SHALL have a `never`-typed default branch so that adding a new part kind without a renderer
fails compilation. New block visuals SHALL enter the design gallery.

#### Scenario: Each part kind renders its block

- **WHEN** a message contains a text, thinking, tool-call, file-edit, plan-card, run-card, presentation, or openable-card part
- **THEN** `MessageBlock` renders the corresponding block

#### Scenario: A plan card renders a dependency graph

- **WHEN** a plan-card part carries steps whose `depends_on` edges form a branching, merging DAG
- **THEN** the plan-card block renders an ASCII graph laying the steps out by dependency depth with box-drawing edges connecting each step to its dependencies

#### Scenario: Independent steps do not imply concurrency

- **WHEN** two steps share a dependency depth and neither lists the other in `depends_on`
- **THEN** they render side by side with no edge between them, and the block shows no run status or execution-order claim

#### Scenario: A degenerate plan falls back to the list

- **WHEN** a plan-card part has an empty/absent `steps` array, or graph rendering returns an error
- **THEN** the plan-card block renders the flat per-step list instead of the graph, without crashing

#### Scenario: A step opens its detail

- **WHEN** the user opens a step of the rendered plan
- **THEN** a detail view shows that step's `question`, `acceptance_criteria`, `constraints`, `caveats`, `resources`, `agent`, and `depends_on`

#### Scenario: Live tool activity renders as a block

- **WHEN** the agent runs a tool during a turn
- **THEN** the stream shows the tool block with the tool's name while running and its outcome (with duration) when finished

#### Scenario: A synthesized table renders inline

- **WHEN** the agent calls `show_user(kind: "table")` with headers and rows
- **THEN** the stream renders the table inline through the markdown renderable, with no open step

#### Scenario: A chart renders as an openable card

- **WHEN** the agent calls `show_user(kind: "echart")`
- **THEN** the stream shows an openable card with the title and resolved cache path, and the design gallery carries an exhibit of the card's states (openable, missing, degraded)

### Requirement: Reasoning is collapsed by default

The thinking/reasoning block SHALL render collapsed by default, showing the marker and a duration/summary, with an affordance to expand the full reasoning body.

#### Scenario: Collapsed then expanded

- **WHEN** a thinking block first renders
- **THEN** the reasoning body is hidden behind an expand affordance, and expanding it reveals the italic reasoning text

### Requirement: Block renderers are domain-agnostic widgets in components/

The stream-block renderers (welcome, thinking, tool-call, run/task, diff, error) are reusable presentational widgets, NOT shell-composition, and SHALL live in `src/tui/components/` (one per file), taking **primitive props** only — they SHALL NOT import the `Part` union or any `src/types/`, `src/db/`, or `src/modules/` code. The domain `Part` → primitive-props mapping SHALL live in `MessageBlock` in `src/tui/layout/` (the one domain-coupled bridge). This keeps `src/tui/layout/` reserved for the shell frame (status bar, sidebar, input bar, the message-block mapper) and the block widgets reusable.

#### Scenario: A block widget is domain-agnostic

- **WHEN** a block widget (e.g. `ToolBlock`, `DiffBlock`) is defined
- **THEN** it resides in `src/tui/components/`, accepts primitive props, and imports nothing from `src/types/`/`src/db/`/`src/modules/`

#### Scenario: The mapper bridges Part to widgets

- **WHEN** an assistant turn contains non-text parts
- **THEN** `MessageBlock` (in `layout/`) switches on the part kind and passes primitive props to the matching `components/` widget

### Requirement: Embedded opentui renderables receive themed colors

Every opentui renderable a block embeds that can paint text or color (`<code>`, `<diff>`, `<markdown>`) SHALL receive its colors from the active theme at the call site; relying on an opentui built-in default color (default foreground `#FFFFFF`, diff bands `#1a4d1a`/`#4d1a1a`, line numbers `#888888`, signs `#22c55e`/`#ef4444`) is a violation. Concretely: `<code>` SHALL receive `fg={theme().fg}` in addition to `syntaxStyle` (with zero tree-sitter highlights, `CodeRenderable` paints via `textBuffer.setText()` using the renderable's own default foreground, bypassing the syntax-style `"default"` scope — the prop is not redundant); `<diff>` SHALL receive `fg`, `syntaxStyle`, `addedBg={theme().diffAddedBg}`, `removedBg={theme().diffRemovedBg}`, `addedSignColor={theme().success}`, `removedSignColor={theme().error}`, and `lineNumberFg={theme().fgMuted}`; `<markdown>` SHALL receive `fg` and `syntaxStyle` (its pipe-table cells are covered by the syntax style's `"default"` scope, since opentui does not forward `fg` to its table child, and the chrome it draws itself — blockquote bars, horizontal rules, and pipe-table frames — is covered by the `"conceal"` scope).

One opentui default is out of the embedder's reach and is a **known exception**: when `<diff>` fails to parse a patch it renders its own error line with a hardcoded `#ef4444`, on a private renderable with no option to override it. The requirement above therefore governs every successfully-parsed diff; a malformed patch may show that one unthemed line. Closing it would require reaching into a private renderable or re-implementing patch parsing (a new dependency), neither of which is warranted for an error path.

#### Scenario: Tool results are readable in light themes

- **WHEN** a tool result (e.g. a data-profile report with plain-text data rows) renders in `ToolBlock` under a light theme
- **THEN** un-highlighted result text renders in the theme's `fg` against the block's background at ≥4.5:1 — never white-on-light

#### Scenario: Diff blocks are themed in both modes

- **WHEN** a `DiffBlock` renders a well-formed patch under any built-in theme
- **THEN** context lines use the theme's `fg`, added/removed row bands use `diffAddedBg`/`diffRemovedBg`, signs use `success`/`error`, and line numbers use `fgMuted` — no opentui default color is visible in either mode

#### Scenario: A malformed patch may show the one unthemed line

- **WHEN** `<diff>` cannot parse the patch it was given
- **THEN** it renders its own error line in opentui's hardcoded `#ef4444`, which the embedder cannot override — the single documented exception to this requirement

#### Scenario: Theme switch recolors embedded renderables

- **WHEN** the active theme changes while a tool result or diff is on screen
- **THEN** the embedded renderable's colors follow the new theme on the next frame (the props read `theme()` in a tracking scope)

### Requirement: Design gallery surfaces every state from mock fixtures

The system SHALL provide a `DesignGallery`, reachable via a `view.design-gallery` command, that renders all eight block states from the mock fixtures. It SHALL drive the block widgets (and `MessageBlock`) directly, bypassing the live conversation store and event bus, so no mock data leaks into a real session.

#### Scenario: Gallery renders all states without touching the store

- **WHEN** the `view.design-gallery` command opens the gallery
- **THEN** every block state renders from the mock fixtures, and the live conversation store / event bus is not mutated
