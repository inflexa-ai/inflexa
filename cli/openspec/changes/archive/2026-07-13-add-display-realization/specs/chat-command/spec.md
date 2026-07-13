# chat-command — delta

## MODIFIED Requirements

### Requirement: The printer renders the emit stream coarsely and safely

The command's emit sink SHALL render, to stdout: accumulated `text-delta` content as it
arrives (no paced/typewriter reveal), one-line tool chips on `tool-started` completed on
`tool-finished` (tool name and outcome), and text renderings of the `data-plan` (plan
id, title, step list) and `data-run-card` (run id, title, step count — the fields the
harness `RunCardData` contract carries; it has no run-status field) parts. Text-shaped
`data-presentation` parts (`markdown`, `code`, `table`) SHALL print inline as text
(markdown source; code fenced; tables as aligned text). Pixel-shaped parts —
`echart`/`svg` presentations (materialized through the shared cache),
`data-file-reference` entries, and `data-report-preview` — SHALL print one line per
entry carrying a kind tag, title, and the resolved path wrapped in an OSC 8 `file://`
hyperlink with the plain path visible for terminals without hyperlink support;
`data-report-preview-failed` prints its reason. Events originating from sub-agents
(call path deeper than the top-level agent) SHALL be dropped. Any other
conversation-emitted part SHALL print a one-line tagged fallback rather than being
silently swallowed. The sink SHALL extract what it renders at receipt and SHALL NOT
retain received event or part objects (in-process emit shares mutable references with
the agent loop). Diagnostics go to stderr; stdout carries only the conversation.

#### Scenario: Streaming text renders as it arrives

- **WHEN** the agent streams a text answer
- **THEN** stdout shows the accumulated text growing per received chunk, with no per-character pacing

#### Scenario: Tool activity is visible as chips

- **WHEN** the agent calls a tool during a turn
- **THEN** stdout shows a chip line when the call starts and its outcome when it finishes

#### Scenario: A plan part renders readably

- **WHEN** the agent presents a plan via `show_plan`
- **THEN** stdout renders the plan id, title, and per-step lines from the embedded plan content

#### Scenario: An openable renders as a linked path

- **WHEN** the agent shows a file via `show_file`
- **THEN** stdout prints a line per file with its caption and resolved absolute path, hyperlinked via OSC 8 and readable as plain text

#### Scenario: Sub-agent traffic stays out of the transcript

- **WHEN** an inner agent (planner, literature reviewer) emits events during a turn
- **THEN** none of its deltas or tool chips appear on stdout

#### Scenario: Unknown parts are observed, not hidden

- **WHEN** the agent emits a conversation part the printer has no renderer for
- **THEN** stdout shows a one-line tagged mention of the part type
