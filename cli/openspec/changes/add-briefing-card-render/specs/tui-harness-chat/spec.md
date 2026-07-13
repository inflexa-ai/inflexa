# tui-harness-chat Specification (delta)

## MODIFIED Requirements

### Requirement: The TUI chat drives the shared turn engine over harness contracts

A submitted message SHALL run one turn of the shared turn engine (`prepareChatTurn → runAgent` with
the streaming provider wrapper `→ appendTurn`, persisting `[userMessage, …loopOutput]`, or
`[userMessage]` alone on abort/throw) under a turn-scoped abort signal wired to the existing abort
chord (dialog-dismiss → abort-turn → quit ordering preserved). The TUI's emit adapter SHALL consume
the harness `contracts/` vocabulary directly (never the cli bus event shapes): text deltas accumulate
in the streaming signal and flush into the store on turn completion; `tool-started`/`tool-finished`
become a live tool part; `data-plan`/`data-run-card`/`data-briefing-card` become card parts; any
other conversation part renders a tagged mention (observed, not hidden); sub-agent events (call path
deeper than the top-level agent) are dropped. Every value crossing into the Solid store SHALL be
extracted or cloned at receipt — in-process emit shares mutable references with the agent loop. The
agent session SHALL carry the thread id in scope (chat-launched runs stamp `cortex_runs.thread_id`)
with a length-1 `callPath` identifying the TUI surface.

#### Scenario: A plan is drafted, approved conversationally, and executed from the TUI

- **WHEN** the user asks for a plan, the agent presents it, and the user's next message approves it
- **THEN** the transcript shows the plan card, then the run card of a real launched run whose `thread_id` equals the chat's thread id

#### Scenario: A standing briefing renders as a card

- **WHEN** the harness emits a `data-briefing-card` part at conversation start (a completed-profile first turn)
- **THEN** the emit adapter maps it to a `briefing-card` `Part` carrying the primitive `name` and `caption`, and a reloaded thread reconstructs the same card

#### Scenario: Abort ends the turn, not the app

- **WHEN** the user hits the abort chord during a streaming turn
- **THEN** the turn's signal aborts, the user message is persisted, the UI returns to idle, and the app stays open
