# tui-stream-blocks — delta

## MODIFIED Requirements

### Requirement: Message block renders all part kinds exhaustively

`MessageBlock` SHALL render an assistant turn's parts by switching on the part discriminant
(`part.type`) for each kind in the extended `Part` union — text, thinking, tool-call, file-edit,
plan-card, run-card, presentation, openable-card — delegating to the matching block renderer. The
harness-sourced kinds render live data: the tool-call block renders real tool activity (name,
running/finished/error outcome, duration), and the run-card block renders run id, title, and step
count (the fields the harness contract carries — it has no run-status field). The plan-card block
renders plan id, title, and a hand-rolled ASCII **dependency graph** of its steps — steps laid out
by topological depth, one box per step, edges drawn from each step's `depends_on` — composed as a
string and rendered through a `<text>` renderable (no custom cell drawing); it falls back to a flat
per-step list when `steps` is empty/absent or graph rendering fails (a `Result`), and its steps are
openable to a detail view. The graph SHALL depict dependency structure only and SHALL carry no run
status: independent steps drawn side by side assert that neither depends on the other, never that
they run concurrently (the harness resource-budget scheduler may serialize them). The presentation
block renders text-shaped `show_user` content inline through the existing `<markdown>` renderable
(`markdown` bodies directly; `code` as a fenced block; `table` as a markdown table). The
openable-card block renders pixel-shaped content as a card: optional title, one row per entry (type
glyph from `GLYPHS`, name, optional caption), the resolved path, and a degraded state for missing
entries. Card parts carry only primitive fields extracted at receipt, never harness objects — the
plan-card part carries each step's `id`, `name`, `agent`, `depends_on`, and the detail fields
(`question`, `acceptance_criteria`, `constraints`, `caveats`, `resources`, `track`, `step_type`),
each deep-copied at receipt. A conversation part with no dedicated renderer SHALL render a one-line
tagged mention (observed, not silently swallowed). The switch SHALL have a `never`-typed default
branch so that adding a new part kind without a renderer fails compilation. New block visuals SHALL
enter the design gallery.

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
