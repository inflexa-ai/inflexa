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
become a live tool part carrying the harness-computed call detail and the call's three-way outcome
(`ok` / `error` / `denied`); `data-plan`/`data-run-card` become card parts; any other conversation part
renders a tagged mention (observed, not hidden); sub-agent events (call path deeper than the
top-level agent) are dropped. The adapter SHALL treat the detail as opaque display text and SHALL NOT
parse it. Every value crossing into the Solid store SHALL be extracted or cloned
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

#### Scenario: A described call carries its detail onto the live part

- **WHEN** the loop emits `tool-started` for a tool that declares a call description
- **THEN** the live tool part carries that detail as a copied primitive, and the chip renders it

#### Scenario: A refused approval reaches the store as denied

- **WHEN** the loop emits `tool-finished` with the denied outcome
- **THEN** the live tool part's status is `denied`, distinct from `error`

## ADDED Requirements

### Requirement: A reloaded thread shows each call's detail and outcome

A reloaded tool call SHALL show the same detail its live chip showed, including for tools the embedder
contributes through the host-tools seam, and SHALL report its own outcome — a call that failed live
renders as failed, a refused call renders as denied. Reporting every reloaded call as a success is a lie
about work the user already saw fail.

This requirement states the outcome, not the mechanism. It is satisfied by replaying what the turn
recorded when it displayed it (see the conversation-display capability); it MUST NOT be satisfied by
re-deriving either value at read time from a tool's current schema or from workspace state, which would
make a past turn's transcript a function of today's code.

#### Scenario: A reloaded call shows the detail its live chip showed

- **GIVEN** a persisted turn whose tool declared a call description
- **WHEN** the thread is reloaded
- **THEN** the tool part carries the same detail the live turn rendered

#### Scenario: A host-contributed tool keeps its detail across reload

- **GIVEN** a persisted call to a tool wired through the host-tools seam
- **WHEN** the thread is reloaded
- **THEN** its detail is present rather than dropped

#### Scenario: A reloaded failed call renders as failed

- **GIVEN** a persisted turn holding a tool call that produced an error result
- **WHEN** the thread is reloaded
- **THEN** the tool block shows the error status, not `ok`

#### Scenario: A reloaded refused call renders as denied

- **GIVEN** a persisted turn holding a tool call whose approval was rejected
- **WHEN** the thread is reloaded
- **THEN** the tool block shows the denied status, distinct from the error status

#### Scenario: Reload before boot completes does not fail

- **GIVEN** a reload that runs while the runtime handle is not yet available
- **WHEN** the reload path runs
- **THEN** it returns without rebuilding, exactly as it does today, and no resolver is constructed
