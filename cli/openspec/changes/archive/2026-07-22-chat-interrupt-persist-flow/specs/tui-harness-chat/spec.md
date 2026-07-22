## MODIFIED Requirements

### Requirement: The TUI chat drives the shared turn engine over harness contracts

A submitted message SHALL run one turn of the shared turn engine (`prepareChatTurn → runAgent` with
the streaming provider wrapper `→ appendTurn`) under a turn-scoped abort signal wired to the existing
abort chord (dialog-dismiss → abort-turn → quit ordering preserved). On completion the engine SHALL
persist `[userMessage, …loopOutput]`; on an aborted run — which RESOLVES with `finish.reason:
"aborted"` and the partial transcript under the harness abort contract — it SHALL persist
`[userMessage, …partialLoopOutput]`, an empty partial degenerating to `[userMessage]` alone; on a
thrown failure it SHALL persist `[userMessage]`. The TUI's emit adapter SHALL consume
the harness `contracts/` vocabulary directly (never the cli bus event shapes): text deltas accumulate
in the streaming signal and flush into the store on turn completion; `tool-started`/`tool-finished`
become a live tool part; `data-plan`/`data-run-card` become card parts; any other conversation part
renders a tagged mention (observed, not hidden); sub-agent events (call path deeper than the
top-level agent) are dropped. Every value crossing into the Solid store SHALL be extracted or cloned
at receipt — in-process emit shares mutable references with the agent loop. The agent session SHALL
carry the thread id in scope (chat-launched runs stamp `cortex_runs.thread_id`) with a length-1
`callPath` identifying the TUI surface.

#### Scenario: A plan is drafted, approved conversationally, and executed from the TUI

- **WHEN** the user asks for a plan, the agent presents it, and the user's next message approves it
- **THEN** the transcript shows the plan card, then the run card of a real launched run whose `thread_id` equals the chat's thread id

#### Scenario: Abort ends the turn, not the app

- **WHEN** the user hits the abort chord during a streaming turn
- **THEN** the turn's signal aborts, the user message and the streamed partial are persisted, the UI returns to idle, and the app stays open

#### Scenario: Sub-agent traffic stays out of the transcript

- **WHEN** an inner agent (planner, literature reviewer) emits deltas or tool events during a turn
- **THEN** none of them render in the stream

### Requirement: Interrupt is a discoverable, quiet affordance

The chat SHALL offer a dedicated interrupt key: the remappable `app.interrupt` binding (default `esc`),
fired by a **double press while a turn is busy, with the chat as the main focus in NORMAL mode**. The
first press SHALL arm the interrupt for a 5-second window; the second press within the window SHALL
fire the turn's existing abort signal. Esc presses claimed by another owner — a stacked dialog, an
active text selection, or the composer's INSERT→NORMAL switch — SHALL NOT count toward the interrupt.
When idle, or when the window expires unfired, esc SHALL behave exactly as before. The ctrl+c
three-way chord and `/quit`-while-busy SHALL be unchanged.

An interrupted turn SHALL end quietly: whatever streamed stays on screen, the chat returns to idle,
and no error banner, toast, or turn-failure surface appears — interruption is a user action, not a
failure. When the interrupted turn streamed output, its assistant message SHALL carry a muted
"interrupted" marker; when it produced nothing, no empty assistant message SHALL remain and no marker
SHALL render. The marker SHALL be durable: the persisted partial carries the harness interruption
marker, a transcript reload derives the same muted marker from the converted message's `interrupted`
field, and the reloaded transcript SHALL render what the live view showed — partial text with the
marker, or no assistant bubble for a no-output abort (which persists no assistant row).

#### Scenario: Double esc interrupts a streaming turn

- **WHEN** a turn is streaming, the chat is the main focus in NORMAL mode, and the user presses esc twice within the window
- **THEN** the turn aborts, the streamed text stays on screen with the muted interrupted marker, the chat returns to idle, and no error surface appears

#### Scenario: The interrupted reply survives a restart

- **WHEN** a turn is interrupted mid-stream and the app is later restarted (or the session reloaded)
- **THEN** the transcript shows the partial reply with the muted interrupted marker, and the next turn's model context contains the partial — a follow-up like "continue" can pick up where the cut landed

#### Scenario: The composer's esc switches modes without arming

- **WHEN** a turn is streaming with the composer focused and the user presses esc once
- **THEN** focus moves to the scroll pane exactly as before, and the interrupt is not armed

#### Scenario: The armed window expires

- **WHEN** the user presses esc once in NORMAL mode during a turn and lets the 5-second window lapse before pressing again
- **THEN** no interrupt fires and the next esc press behaves as a fresh first press

#### Scenario: Interrupting a turn that produced nothing leaves no shell

- **WHEN** a turn is interrupted before any text delta or part arrived
- **THEN** no empty assistant message and no marker render; the user message remains in the transcript — live and after reload alike

#### Scenario: Esc while idle is unchanged

- **WHEN** no turn is in flight and the user presses esc anywhere in the chat
- **THEN** esc behaves exactly as it did before this requirement
