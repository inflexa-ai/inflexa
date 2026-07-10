# tui-stream-blocks Specification

## Purpose
TBD - created by archiving change inflexa-design-system. Update Purpose after archive.
## Requirements
### Requirement: Eight canonical stream-block states

The chat stream SHALL render the eight canonical block states of the design system, each as a gutter-marked block sharing the fixed 2-cell gutter (`size.gutter`) so only the marker glyph and its role color change between blocks:

1. **welcome / startup** — shown at the top of an empty stream; a wordmark plus the active context (greeting, anchor path with ✓/⚠ badge, resume hint, command hint).
2. **plain chat turn** — the existing user/assistant `MessageBlock` (markdown body under a `>`/`<` marker).
3. **thinking / reasoning** — a `◆ thinking` marker, an optional duration, and a collapsed-by-default italic reasoning body that can expand.
4. **tool call & result** — a `▸` marker with the tool/verb name and target, the result rendered in a `<code>` block, and a completion line.
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

### Requirement: Message block renders all part kinds exhaustively

`MessageBlock` SHALL render an assistant turn's parts by switching on the part discriminant
(`part.type`) for each kind in the extended `Part` union — text, thinking, tool-call, file-edit,
plan-card, run-card — delegating to the matching block renderer. The harness-sourced kinds render
live data: the tool-call block renders real tool activity (name, running/finished/error outcome,
duration), the plan-card block renders plan id, title, and per-step lines, and the run-card block
renders run id, title, and step count (the fields the harness contract carries — it has no
run-status field). Card parts carry only primitive fields extracted at receipt, never harness
objects. A conversation part with no dedicated renderer SHALL render a one-line tagged mention
(observed, not silently swallowed). The switch SHALL have a `never`-typed default branch so that
adding a new part kind without a renderer fails compilation. New block visuals SHALL enter the
design gallery.

#### Scenario: Each part kind renders its block

- **WHEN** a message contains a text, thinking, tool-call, file-edit, plan-card, or run-card part
- **THEN** `MessageBlock` renders the corresponding block

#### Scenario: Live tool activity renders as a block

- **WHEN** the agent runs a tool during a turn
- **THEN** the stream shows the tool block with the tool's name while running and its outcome (with duration) when finished

#### Scenario: A plan part renders readably

- **WHEN** the agent presents a plan
- **THEN** the stream renders the plan's id, title, and per-step lines in the plan-card block

#### Scenario: Unhandled part kind breaks the build

- **WHEN** a new part kind is added to the `Part` union without a matching case
- **THEN** the `never`-typed default branch causes a type error

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

Every opentui renderable a block embeds that can paint text or color (`<code>`, `<diff>`, `<markdown>`) SHALL receive its colors from the active theme at the call site; relying on an opentui built-in default color (default foreground `#FFFFFF`, diff bands `#1a4d1a`/`#4d1a1a`, line numbers `#888888`, signs `#22c55e`/`#ef4444`) is a violation. Concretely: `<code>` SHALL receive `fg={theme().fg}` in addition to `syntaxStyle` (with zero tree-sitter highlights, `CodeRenderable` paints via `textBuffer.setText()` using the renderable's own default foreground, bypassing the syntax-style `"default"` scope — the prop is not redundant); `<diff>` SHALL receive `fg`, `syntaxStyle`, `addedBg={theme().diffAddedBg}`, `removedBg={theme().diffRemovedBg}`, `addedSignColor={theme().success}`, `removedSignColor={theme().error}`, and `lineNumberFg={theme().fgMuted}`; `<markdown>` SHALL receive `fg` and `syntaxStyle` (its pipe-table cells are covered by the syntax style's `"default"` scope, since opentui does not forward `fg` to its table child).

#### Scenario: Tool results are readable in light themes

- **WHEN** a tool result (e.g. a data-profile report with plain-text data rows) renders in `ToolBlock` under a light theme
- **THEN** un-highlighted result text renders in the theme's `fg` against the block's background at ≥4.5:1 — never white-on-light

#### Scenario: Diff blocks are themed in both modes

- **WHEN** a `DiffBlock` renders under any built-in theme
- **THEN** context lines use the theme's `fg`, added/removed row bands use `diffAddedBg`/`diffRemovedBg`, signs use `success`/`error`, and line numbers use `fgMuted` — no opentui default color is visible in either mode

#### Scenario: Theme switch recolors embedded renderables

- **WHEN** the active theme changes while a tool result or diff is on screen
- **THEN** the embedded renderable's colors follow the new theme on the next frame (the props read `theme()` in a tracking scope)

### Requirement: Design gallery surfaces every state from mock fixtures

The system SHALL provide a `DesignGallery`, reachable via a `view.design-gallery` command, that renders all eight block states from the mock fixtures. It SHALL drive the block widgets (and `MessageBlock`) directly, bypassing the live conversation store and event bus, so no mock data leaks into a real session.

#### Scenario: Gallery renders all states without touching the store

- **WHEN** the `view.design-gallery` command opens the gallery
- **THEN** every block state renders from the mock fixtures, and the live conversation store / event bus is not mutated

