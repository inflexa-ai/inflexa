## MODIFIED Requirements

### Requirement: The printer renders the emit stream coarsely and safely

The command's emit sink SHALL render, to stdout: accumulated `text-delta` content as it
arrives (no paced/typewriter reveal), one-line tool chips on `tool-started` completed on
`tool-finished` (tool name, the harness-computed call detail when the tool supplies one, and
outcome), and text renderings of the `data-plan` (plan
id, title, and the step dependency graph — the same `planToDag` rendering the TUI
plan-card block uses, emitted as plain text, falling back to a per-step list when steps
are absent or rendering fails) and `data-run-card` (run id, title, step count — the fields the
harness `RunCardData` contract carries; it has no run-status field) parts. A chip's outcome SHALL
distinguish the three harness states — done, error, and denied — so a refused approval does not print
as a failure. Text-shaped
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
the agent loop). The detail SHALL be treated as opaque display text and SHALL NOT be parsed.
Diagnostics go to stderr; stdout carries only the conversation.

#### Scenario: Streaming text renders as it arrives

- **WHEN** the agent streams a text answer
- **THEN** stdout shows the accumulated text growing per received chunk, with no per-character pacing

#### Scenario: Tool activity is visible as chips

- **WHEN** the agent calls a tool during a turn
- **THEN** stdout shows a chip line when the call starts and its outcome when it finishes

#### Scenario: A described call names what it is doing

- **WHEN** the agent calls a tool that declares a call description
- **THEN** the chip line carries the tool name and its detail, and a tool without one prints the name alone as before

#### Scenario: A refused approval is not printed as a failure

- **WHEN** a tool call finishes with the denied outcome
- **THEN** the chip reports the denial, distinct from the wording used for an error
