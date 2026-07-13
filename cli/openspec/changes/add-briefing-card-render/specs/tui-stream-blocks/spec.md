# tui-stream-blocks Specification (delta)

## MODIFIED Requirements

### Requirement: Message block renders all part kinds exhaustively

`MessageBlock` SHALL render an assistant turn's parts by switching on the part discriminant
(`part.type`) for each kind in the extended `Part` union — text, thinking, tool-call, file-edit,
plan-card, run-card, briefing-card — delegating to the matching block renderer. The harness-sourced
kinds render live data: the tool-call block renders real tool activity (name, running/finished/error
outcome, duration), the plan-card block renders plan id, title, and per-step lines, the run-card
block renders run id, title, and step count, and the briefing-card renders one muted, single-line
marker of the briefing's `caption` (no body, no interactivity). Card parts carry only primitive
fields extracted at receipt, never harness objects. A conversation part with no dedicated renderer
SHALL render a one-line tagged mention (observed, not silently swallowed). The switch SHALL have a
`never`-typed default branch so that adding a new part kind without a renderer fails compilation.
New block visuals SHALL enter the design gallery.

#### Scenario: Each part kind renders its block

- **WHEN** a message contains a text, thinking, tool-call, file-edit, plan-card, run-card, or briefing-card part
- **THEN** `MessageBlock` renders the corresponding block

#### Scenario: A briefing card renders one muted line

- **WHEN** a message carries a `briefing-card` part
- **THEN** the stream renders a single dim line summarizing the briefing's caption, with no expandable body

#### Scenario: Unhandled part kind breaks the build

- **WHEN** a new part kind is added to the `Part` union without a matching case
- **THEN** the `never`-typed default branch causes a type error
