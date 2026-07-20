## ADDED Requirements

### Requirement: The openable card's marker column signals openability, not content kind

The openable card's row marker SHALL answer exactly one question — does this row open, or is it broken — and SHALL NOT encode content kind.

- Every openable row, including the reveal-containing-folder row, SHALL render `GLYPHS.arrowUpRight` (`↗`, U+2197) in the `accent` role: the conventional "opens outside this surface" affordance, and an honest description of what every row in the card does. The folder row remains distinguished by its `fgMuted` label and its position after the entry rows.
- A degraded row (a missing file, or a failed preview) SHALL render `GLYPHS.cross` (`✗`) in the `error` role, so failure contrasts with the affordance instead of reading as one more kind.
- The card title SHALL NOT carry a leading marker glyph. A bold title above indented rows already reads as a group, and the previously-used filled circle carried no information.

Content kind SHALL be conveyed by the entry's name and file extension, which distinguish kinds more reliably than a single-cell glyph can, rather than by the marker. Consequently the content-kind icon vocabulary SHALL be removed rather than remapped: `OpenableIcon`, the `icon` field on `OpenableEntry` and on the block's row-view type, and the `iconForPath` derivation are deleted, since with a uniform marker the field has no reader and a field with no reader is worse than no field. No harness payload carried `icon` — it was derived CLI-locally from the file extension plus four hardcoded call sites — so no wire contract changes. Persisted `Part` rows are read through an unchecked `JSON.parse(...) as Part` cast with no schema validation, so previously-written rows retaining an `icon` key SHALL deserialize unchanged with the stale key ignored.

The rationale is vocabulary collision: the previous marker set drew every one of its shapes from meanings already in use elsewhere — the filled circle is the plan-card marker, the multi-select selected state, the active radio dot, the chat `ready` status and three sidebar run states; the half-filled circle is thinking, booting, and ask-pending; the right triangle is the tool-running marker *and* the folder affordance inside this same card. Stacking a title circle above a half-circle chart row produced two near-identical adjacent glyphs carrying unrelated meanings.

#### Scenario: An openable entry shows the open affordance

- **WHEN** an openable card renders an entry that resolves to a path
- **THEN** the row's marker is `↗` in the `accent` role, regardless of whether the entry is a chart, an image, a document, or a report

#### Scenario: A degraded entry is visually distinct from an openable one

- **WHEN** an openable card renders an entry whose target is missing or whose preview failed
- **THEN** the row's marker is `✗` in the `error` role and its reason renders in the `error` role

#### Scenario: The folder affordance shares the open vocabulary

- **WHEN** a multi-file gallery renders its reveal-containing-folder row
- **THEN** that row also renders `↗`, and is distinguished from the entry rows by its muted label and trailing position rather than by a different glyph

#### Scenario: The card title carries no bullet

- **WHEN** an openable card renders with a title
- **THEN** the title renders as bold text with no leading marker glyph, at the theme foreground

#### Scenario: The gutter constraint still holds

- **WHEN** `↗` renders in a card row
- **THEN** it occupies a single terminal cell, so column alignment with the surrounding blocks is preserved and no double-width or emoji glyph is introduced

## MODIFIED Requirements

### Requirement: Embedded opentui renderables receive themed colors

Every opentui renderable a block embeds that can paint text or color (`<code>`, `<diff>`, `<markdown>`) SHALL receive its colors from the active theme at the call site; relying on an opentui built-in default color (default foreground `#FFFFFF`, diff bands `#1a4d1a`/`#4d1a1a`, line numbers `#888888`, signs `#22c55e`/`#ef4444`) is a violation. Concretely: `<code>` SHALL receive `fg={theme().fg}` in addition to `syntaxStyle` (with zero tree-sitter highlights, `CodeRenderable` paints via `textBuffer.setText()` using the renderable's own default foreground, bypassing the syntax-style `"default"` scope — the prop is not redundant); `<diff>` SHALL receive `fg`, `syntaxStyle`, `addedBg={theme().diffAddedBg}`, `removedBg={theme().diffRemovedBg}`, `addedSignColor={theme().success}`, `removedSignColor={theme().error}`, and `lineNumberFg={theme().fgMuted}`; `<markdown>` SHALL receive `fg` and `syntaxStyle` (its pipe-table cells are covered by the syntax style's `"default"` scope, since opentui does not forward `fg` to its table child, and the chrome it draws itself — blockquote bars, horizontal rules, and pipe-table frames — is covered by the `"conceal"` scope).

This obligation SHALL extend to the block's **own** `<text>` elements, not only to the renderables it embeds. The same `#FFFFFF` default reaches a `<text>` that carries no `fg`, and reaches any `<Bold>`/`<Italic>`/`<Underline>`/`<Dim>` that has no colored ancestor — so a block's title, label, and hint rows SHALL each resolve an explicit theme foreground, by an `fg` prop on the `<text>` or by wrapping their content in `<Fg>`/`<Reverse>`. A block is compliant only when *every* span it paints resolves a theme color, whether that span is drawn by an embedded renderable or by the block itself.

One opentui default is out of the embedder's reach and is a **known exception**: when `<diff>` fails to parse a patch it renders its own error line with a hardcoded `#ef4444`, on a private renderable with no option to override it. The requirement above therefore governs every successfully-parsed diff; a malformed patch may show that one unthemed line.

#### Scenario: Tool results are readable in light themes

- **WHEN** a tool result (e.g. a data-profile report with plain-text data rows) renders in `ToolBlock` under a light theme
- **THEN** un-highlighted result text renders in the theme's `fg` against the block's background at ≥4.5:1 — never white-on-light

#### Scenario: A block's own title text is themed

- **WHEN** a stream block renders its own title, label, or hint row under a light theme
- **THEN** that text resolves an explicit theme foreground at ≥4.5:1, never the renderable's white default

#### Scenario: Diff blocks are themed in both modes

- **WHEN** a `DiffBlock` renders a well-formed patch under any built-in theme
- **THEN** context lines use the theme's `fg`, added/removed row bands use `diffAddedBg`/`diffRemovedBg`, signs use `success`/`error`, and line numbers use `fgMuted` — no opentui default color is visible in either mode

#### Scenario: A malformed patch may show the one unthemed line

- **WHEN** `<diff>` cannot parse the patch it was given
- **THEN** it renders its own error line in opentui's hardcoded `#ef4444`, which the embedder cannot override — the single documented exception to this requirement

#### Scenario: Theme switch recolors embedded renderables

- **WHEN** the active theme changes while a tool result or diff is on screen
- **THEN** the embedded renderable's colors follow the new theme on the next frame (the props read `theme()` in a tracking scope)

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
pixel-shaped content as a card: optional title, one row per entry (the open-affordance marker from
`GLYPHS`, name, optional caption), the resolved path, and a degraded state for missing entries — the
row marker signals openability rather than content kind (see "The openable card's marker column
signals openability, not content kind"). Card parts carry
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
- **THEN** the stream shows an openable card with the title and resolved presentations-file path, and the design gallery carries an exhibit of the card's states (openable, missing, degraded)
