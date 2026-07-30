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

The engine's outcome SHALL additionally carry the turn's usage rollup when the run reported one — the
harness's per-quantity record, carried whole rather than reduced to a single number. The engine
passes no usage accumulator into `runAgent`, so its loop is by the harness's contract the turn's root
and its finish carries the whole-turn rollup with every descendant sub-agent loop included; that
rollup — not the root loop's own — is what the outcome SHALL carry. The rollup SHALL be absent, never
zeroed, when no call reported usage.

A turn that RESOLVES — including the ordinary interrupt, which the harness resolves with an
`"aborted"` finish and a partial transcript — SHALL carry whatever was spent before it ended rather
than discarding it. A turn that instead THROWS produced no finish and therefore has no rollup to
carry; its outcome SHALL carry none rather than a fabricated or zeroed one. Those tokens are not
lost: the loop delivers each call to the usage recorder at call completion, before any branch that
can end the turn, so a thrown turn's spend is already in the ledger. The live rollup and the ledger
answer different questions here, in the opposite direction from the usual one — the ledger is what
survives a turn whose return value never happened.

#### Scenario: A plan is drafted, approved conversationally, and executed from the TUI

- **WHEN** the user asks for a plan, the agent presents it, and the user's next message approves it
- **THEN** the transcript shows the plan card, then the run card of a real launched run whose `thread_id` equals the chat's thread id

#### Scenario: Abort ends the turn, not the app

- **WHEN** the user hits the abort chord during a streaming turn
- **THEN** the turn's signal aborts, the user message and the streamed partial are persisted, the UI returns to idle, and the app stays open

#### Scenario: Sub-agent traffic stays out of the transcript

- **WHEN** an inner agent (planner, literature reviewer) emits deltas or tool events during a turn
- **THEN** none of them render in the stream

#### Scenario: The turn's rollup includes what its sub-agents spent

- **WHEN** a turn dispatches a sub-agent loop that makes its own LLM calls
- **THEN** the outcome's rollup covers both loops' calls, exceeding what the top-level loop alone reported

#### Scenario: An interrupted turn still reports what it spent

- **WHEN** the user aborts a turn after several completed calls
- **THEN** the outcome carries those calls' rollup rather than no rollup at all

#### Scenario: A turn that reported no usage carries no rollup

- **GIVEN** a provider that reports no usage
- **WHEN** the turn completes
- **THEN** the outcome's rollup is absent rather than a zeroed one

## ADDED Requirements

### Requirement: A finished turn displays what it cost

The TUI SHALL render what the turn consumed on the completed assistant message, alongside the
duration it already stamps there, as an input figure and an output figure — never as one combined
number, since the rollup's remaining quantities are breakdowns of those two. The display SHALL
distinguish "nothing was reported" from "zero was spent" by rendering nothing at all in the former
case, and SHALL NOT block, delay, or alter the message's other content when the rollup is absent.

#### Scenario: A completed turn shows its tokens beside its duration

- **WHEN** a turn completes and its provider reported usage
- **THEN** the assistant message's meta line carries the turn's input and output figures next to its elapsed time

#### Scenario: A turn with no reported usage shows no token figure

- **WHEN** a turn completes and no call reported usage
- **THEN** the meta line shows the duration alone, with no zero and no placeholder

#### Scenario: The meta line never shows a summed token count

- **WHEN** a turn's rollup carries cache-read or reasoning counts alongside its input and output counts
- **THEN** the meta line still shows two figures, neither of which has the cache or reasoning counts added into it
