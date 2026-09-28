## MODIFIED Requirements

### Requirement: The TUI chat drives the shared turn engine over harness contracts

A submitted message MUST run one turn of the shared turn engine under a turn-scoped abort signal. The abort chord keeps its order: dialog-dismiss, then abort-turn, then quit.

The engine MUST call `runChatTurn` of the harness with these values:

- the thread-agent resolver of the runtime handle, never a pre-selected agent
- the streaming provider wrapper
- the emit sink of the TUI and the signal of the turn
- the usage recorder of the runtime and the approval binding of the turn
- the author and the start time of the turn

The engine passes no cache policy, thus the root conversation loop uses the 1-hour default of the harness. The harness stores the opening of the turn, each round when it completes, and the outcome. The engine MUST NOT append a row itself.

A type that the harness refuses (`unregistered_thread_type`) MUST end the turn as its own terminal outcome, and the harness stores nothing. The TUI MUST render it through the failed-turn notice path, and it names the thread type.

A turn that the user interrupts keeps its stored rounds, and the harness closes it as `aborted`. A turn whose run throws also keeps its stored rounds. The harness then adds the failure note, and it closes the turn as `failed`.

The emit adapter of the TUI MUST consume the harness `contracts/` vocabulary directly, never the event shapes of the cli bus:

- Each event of the top-level agent goes through `toChatFrame` and `applyChatFrame` of the harness. Thus the assistant message of the turn holds the harness parts that a reload of the turn gives.
- A text delta changes only the streaming signal. The text part in the store takes the text when a later part arrives, or when the turn completes.
- `tool-started` and `tool-finished` become one tool-call part. The part carries the call detail of the harness and the outcome of the call: `ok`, `error`, or `denied`. The adapter MUST treat the detail as opaque display text, and it MUST NOT parse it.
- Each other data part stays in the message as the harness gives it. The renderer shows a part with no renderer as a tagged mention, thus the adapter hides no part.
- A sub-agent event, whose call path is deeper than the top-level agent, becomes the activity line of the running tool call. It never becomes a part.

Each value that crosses into the Solid store MUST be extracted or cloned when it arrives. The emit in the process shares mutable references with the agent loop. The agent session MUST carry the thread id in its scope, thus a run that the chat starts stamps `cortex_runs.thread_id`. Its `callPath` has a length of 1, and it names the TUI surface.

The outcome of the engine MUST also carry the usage rollup of the turn when the run reported one. The rollup is the record of the harness for each quantity, carried whole and not reduced to one number. It covers the root loop of the turn and each sub-agent loop. The rollup MUST be absent, never zero, when no call reported usage.

A turn that returns, the ordinary interrupt included, MUST carry what it spent before it ended. A turn whose run throws produced no finish, thus its outcome MUST carry no rollup. The ledger still holds those tokens, because the loop gives each call to the usage recorder when the call completes.

#### Scenario: A plan is drafted, approved conversationally, and executed from the TUI

- **WHEN** the user asks for a plan, the agent shows it, and the next message of the user approves it
- **THEN** the transcript shows the plan card, and then the run card of a real run whose `thread_id` is the thread id of the chat

#### Scenario: Abort ends the turn, not the app

- **WHEN** the user pushes the abort chord during a streaming turn
- **THEN** the signal of the turn aborts, and the thread keeps the opening, each completed round, and the streamed partial
- **AND** the UI goes idle, and the app stays open

#### Scenario: A failed turn keeps its rounds

- **GIVEN** a turn whose provider fails with HTTP 401 after two rounds
- **WHEN** the turn ends and the transcript loads again
- **THEN** the transcript shows the two rounds and the failure note, and the TUI showed the failure banner

#### Scenario: Sub-agent traffic stays out of the transcript

- **WHEN** an inner agent, for example the planner or the literature reviewer, emits deltas or tool events during a turn
- **THEN** none of them renders as a part of the turn, and only the activity line of the running tool call shows them

#### Scenario: A described call carries its detail onto the live part

- **WHEN** the loop emits `tool-started` for a tool that declares a call description
- **THEN** the live tool-call part carries that detail as a copied string, and the chip renders it

#### Scenario: A refused approval reaches the store as denied

- **WHEN** the loop emits `tool-finished` with the `denied` outcome
- **THEN** the outcome of the live tool-call part is `denied`, not `error`

#### Scenario: The turn's rollup includes what its sub-agents spent

- **WHEN** a turn sends a sub-agent loop that makes its own LLM calls
- **THEN** the rollup of the outcome covers the calls of both loops, and it is more than the top-level loop alone reported

#### Scenario: An interrupted turn still reports what it spent

- **WHEN** the user aborts a turn after some completed calls
- **THEN** the outcome carries the rollup of those calls, not an absent rollup

#### Scenario: A turn that reported no usage carries no rollup

- **GIVEN** a provider that reports no usage
- **WHEN** the turn completes
- **THEN** the rollup of the outcome is absent, not zero

#### Scenario: An unregistered thread type surfaces as a rendered refusal

- **WHEN** a turn runs on a thread whose type has no registered agent in this build
- **THEN** the engine returns the unresolved-agent outcome, the thread gets no row, and the TUI renders the failed-turn notice with the thread type

## ADDED Requirements

### Requirement: A reloaded thread shows each call's detail and outcome

A reloaded tool call MUST show the detail that its live chip showed. This includes a tool that the embedder gives as a host tool. A reloaded call MUST also show its own outcome: a call that failed live renders as failed, and a refused call renders as denied. A reload that shows each call as a success tells the user that a failed call succeeded.

The harness records what a turn displayed when the turn displays it, and `storedMessagesToCortex` replays that record. The store mounts the replayed parts with no change. The reload MUST NOT compute the detail or the outcome again at read time. It MUST NOT read them from the current schema of a tool or from the state of the workspace. Thus the transcript of a past turn does not change with the code of today.

#### Scenario: A reloaded call shows the detail its live chip showed

- **GIVEN** a stored turn whose tool declared a call description
- **WHEN** the thread reloads
- **THEN** the tool-call part carries the same detail that the live turn rendered

#### Scenario: A host tool keeps its detail across reload

- **GIVEN** a stored call to a tool that the embedder gives as a host tool
- **WHEN** the thread reloads
- **THEN** its detail is present, not dropped

#### Scenario: A reloaded failed call renders as failed

- **GIVEN** a stored turn that holds a tool call with an error result
- **WHEN** the thread reloads
- **THEN** the tool block shows the error status, not `ok`

#### Scenario: A reloaded refused call renders as denied

- **GIVEN** a stored turn that holds a tool call whose approval was rejected
- **WHEN** the thread reloads
- **THEN** the tool block shows the denied status, not the error status

#### Scenario: Reload before boot completes does not fail

- **GIVEN** a reload that runs while the runtime handle is not available
- **WHEN** the reload path runs
- **THEN** it returns, and it mounts nothing
