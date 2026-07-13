# tui-stream-blocks — delta

## MODIFIED Requirements

### Requirement: Message block renders all part kinds exhaustively

`MessageBlock` SHALL render an assistant turn's parts by switching on the part discriminant
(`part.type`) for each kind in the extended `Part` union — text, thinking, tool-call, file-edit,
plan-card, run-card, presentation, openable-card — delegating to the matching block renderer. The
harness-sourced kinds render live data: the tool-call block renders real tool activity (name,
running/finished/error outcome, duration), the plan-card block renders plan id, title, and
per-step lines, and the run-card block renders run id, title, and step count (the fields the
harness contract carries — it has no run-status field). The presentation block renders text-shaped
`show_user` content inline through the existing `<markdown>` renderable (`markdown` bodies
directly; `code` as a fenced block; `table` as a markdown table). The openable-card block renders
pixel-shaped content as a card: optional title, one row per entry (type glyph from `GLYPHS`, name,
optional caption), the resolved path, and a degraded state for missing entries. Card parts carry
only primitive fields extracted at receipt, never harness objects. A conversation part with no
dedicated renderer SHALL render a one-line tagged mention (observed, not silently swallowed). The
switch SHALL have a `never`-typed default branch so that adding a new part kind without a renderer
fails compilation. New block visuals SHALL enter the design gallery.

#### Scenario: Each part kind renders its block

- **WHEN** a message contains a text, thinking, tool-call, file-edit, plan-card, run-card, presentation, or openable-card part
- **THEN** `MessageBlock` renders the corresponding block

#### Scenario: Live tool activity renders as a block

- **WHEN** the agent runs a tool during a turn
- **THEN** the stream shows the tool block with the tool's name while running and its outcome (with duration) when finished

#### Scenario: A synthesized table renders inline

- **WHEN** the agent calls `show_user(kind: "table")` with headers and rows
- **THEN** the stream renders the table inline through the markdown renderable, with no open step

#### Scenario: A chart renders as an openable card

- **WHEN** the agent calls `show_user(kind: "echart")`
- **THEN** the stream shows an openable card with the title and resolved cache path, and the design gallery carries an exhibit of the card's states (openable, missing, degraded)
