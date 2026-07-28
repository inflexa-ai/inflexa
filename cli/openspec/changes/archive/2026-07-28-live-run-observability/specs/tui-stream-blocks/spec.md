## MODIFIED Requirements

### Requirement: Message block renders all part kinds exhaustively

`MessageBlock` SHALL render an assistant turn's parts by switching on the part discriminant
(`part.type`) for each kind in the extended `Part` union — text, thinking, tool-call, file-edit,
plan-card, run-card, presentation, openable-card — delegating to the matching block renderer. The
harness-sourced kinds render live data: the tool-call block renders real tool activity (name,
running/finished/error outcome, duration), and the run-card block renders the run's identity
together with its **live lifecycle state**, resolved by looking the run up by the `runId` the part
already carries rather than from any new persisted field. The plan-card block
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

#### Scenario: A run card tracks its run

- **WHEN** a run card's run is active
- **THEN** the card shows that run's live progress, updating as the run advances

#### Scenario: A synthesized table renders inline

- **WHEN** the agent calls `show_user(kind: "table")` with headers and rows
- **THEN** the stream renders the table inline through the markdown renderable, with no open step

#### Scenario: A chart renders as an openable card

- **WHEN** the agent calls `show_user(kind: "echart")`
- **THEN** the stream shows an openable card with the title and resolved presentations-file path, and the design gallery carries an exhibit of the card's states (openable, missing, degraded)

## ADDED Requirements

### Requirement: The run card settles into a terminal record

When its run reaches a terminal status, the run-card block SHALL collapse its live chrome and
render a compact outcome line — the run, its terminal status, its completion count, and its
duration, with the failure reason when it did not succeed.

The card SHALL NOT be hidden or removed on completion. Run cards are reconstructed when a
transcript is reloaded, so a card that disappeared would erase the launch from the conversation's
history; and signalling completion by making a widget vanish is the defect this work exists to
remove. The card SHALL likewise not retain a live progress meter once the run is over — a
progress bar frozen mid-run is a false claim in scroll-back.

A card whose run cannot be resolved SHALL render its identity and say so, never a fabricated
status.

#### Scenario: A completed run's card becomes an outcome line

- **WHEN** the run behind a rendered card completes
- **THEN** the card's progress chrome collapses and a compact line states the run, its terminal status, its counts, and its duration

#### Scenario: A failed run's card carries the reason

- **WHEN** the run behind a rendered card fails
- **THEN** the settled card is rendered in the error tone and carries the failure reason

#### Scenario: The card survives reload as a truthful record

- **WHEN** a transcript containing a finished run's card is reloaded
- **THEN** the card renders its settled outcome, not a placeholder and not a live meter

#### Scenario: An unresolvable run is not faked

- **WHEN** a card's run cannot be found in the ledger
- **THEN** the card shows its recorded identity and an unavailable state rather than inventing a status

### Requirement: A running tool block shows its sub-agent's activity

While a tool call is running, the tool block SHALL show a single subordinate line describing what
the innermost sub-agent working inside that call is currently doing. When the tool call finishes,
that line SHALL disappear, leaving the block's ordinary outcome and duration.

Sub-agent events SHALL be routed to their originating tool block rather than rendered as
transcript-level blocks. A sub-agent's iterations and tool calls are numerous, and emitting them
into the transcript root would bury the conversation; suppressing them entirely — the current
behaviour — makes a long tool call indistinguishable from a wedged one. Only the innermost
activity SHALL be shown, one line at a time.

#### Scenario: A long tool call reports what it is doing

- **WHEN** a tool call spawns a sub-agent that runs for an extended period
- **THEN** the tool block shows a subordinate activity line that updates as the sub-agent works

#### Scenario: The activity line leaves on completion

- **WHEN** the tool call finishes
- **THEN** the subordinate line is gone and the block shows its outcome and duration

#### Scenario: Sub-agent events do not enter the transcript root

- **WHEN** a sub-agent emits iterations and tool events
- **THEN** no transcript-level block is created for them
