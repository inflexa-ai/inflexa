## MODIFIED Requirements

### Requirement: The printer renders the emit stream coarsely and safely

The emit sink of the command MUST render these to stdout:

- Accumulated `text-delta` content as it arrives, with no paced or typewriter reveal.
- A one-line tool chip on `tool-started`, closed on `tool-finished`. The chip carries the tool name, the call detail of the harness when the tool gives one, and the outcome.
- The `data-plan` part as text: the plan id, the title, and the step dependency graph. The graph is the same `planToDag` rendering that the TUI plan-card block uses, emitted as plain text. If the plan has no steps, or the graph fails to render, the sink falls back to a per-step list.
- The `data-run-card` part as text: the run id, the title, and the step count. These are the fields that the harness `RunCardData` contract carries, and it has no run-status field.

The outcome of a chip MUST separate the three harness states: done, error, and denied. Thus a refused approval does not print as a failure. The sink MUST treat the detail as opaque display text, and it MUST NOT parse it.

A text-shaped `data-presentation` part (`markdown`, `code`, `table`) MUST print inline as text. Markdown prints as its source, code prints fenced, and a table prints as aligned text.

A pixel-shaped part MUST print one line for each entry. These parts are an `echart` or `svg` presentation (materialized through the shared cache), and a `data-file-reference` entry. The line carries a kind tag, a title, and the resolved path inside an OSC 8 `file://` hyperlink. The plain path stays visible, for a terminal with no hyperlink support.

A sub-agent event is one whose call path is deeper than the top-level agent. The sink MUST NOT print such an event at the transcript root. If a tool call is open, the sink MUST print the activity label of the event as a subordinate line under that tool call. If no tool call is open, the sink MUST drop the event. Any other conversation-emitted part MUST print a one-line tagged fallback, so the sink observes it rather than swallows it.

The sink MUST extract what it renders at receipt. It MUST NOT retain a received event or part object, because an in-process emit shares mutable references with the agent loop.

Diagnostics go to stderr. Only the conversation goes to stdout.

#### Scenario: Streaming text renders as it arrives

- **WHEN** the agent streams a text answer
- **THEN** stdout shows the accumulated text growing per received chunk, with no per-character pacing

#### Scenario: Tool activity is visible as chips

- **WHEN** the agent calls a tool during a turn
- **THEN** stdout shows a chip line when the call starts and its outcome when it finishes

#### Scenario: A described call names what it is doing

- **WHEN** the agent calls a tool that declares a call description
- **THEN** the chip line carries the tool name and its detail, and a tool with no description prints the name alone

#### Scenario: A refused approval is not printed as a failure

- **WHEN** a tool call finishes with the `denied` outcome
- **THEN** the chip prints `denied`, not the word for an error

#### Scenario: A plan part renders readably

- **WHEN** the agent presents a plan through `show_plan`
- **THEN** stdout renders the plan id, the title, and the step dependency graph as plain text
- **AND** it falls back to a per-step list when the plan has no steps, or when the graph fails to render

#### Scenario: An openable renders as a linked path

- **WHEN** the agent shows a file through `show_file`
- **THEN** stdout prints one line for each file, with its caption and resolved absolute path
- **AND** the path is hyperlinked through OSC 8 and stays readable as plain text

#### Scenario: Sub-agent traffic stays out of the transcript

- **WHEN** an inner agent (planner, literature reviewer) emits events during a turn
- **THEN** no delta and no tool chip of that agent prints at the transcript root
- **AND** an activity label of that agent prints as a subordinate line under the open tool call
- **AND** nothing prints for that agent when no tool call is open

#### Scenario: Unknown parts are observed, not hidden

- **WHEN** the agent emits a conversation part the printer has no renderer for
- **THEN** stdout shows a one-line tagged mention of the part type
