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

- Text deltas collect in the streaming signal, and they flush into the store when the turn completes.
- `tool-started` and `tool-finished` become a live tool part.
- `data-plan` and `data-run-card` become card parts.
- Each other conversation part renders a tagged mention, thus the adapter hides no part.
- The adapter drops sub-agent events, whose call path is deeper than the top-level agent.

Each value that crosses into the Solid store MUST be extracted or cloned when it arrives. The emit in the process shares mutable references with the agent loop. The agent session MUST carry the thread id in its scope, thus a run that the chat starts stamps `cortex_runs.thread_id`. Its `callPath` has a length of 1, and it names the TUI surface.

The outcome of the engine MUST also carry the usage rollup of the turn when the run reported one. The rollup is the record of the harness for each quantity, carried whole and not reduced to one number. It covers the root loop of the turn and each sub-agent loop. The rollup MUST be absent, never zero, when no call reported usage.

A turn that returns, the ordinary interrupt included, MUST carry what it spent before it ended. A turn whose run throws produced no finish, thus its outcome MUST carry no rollup. The ledger still holds those tokens, because the loop gives each call to the usage recorder when the call completes.

#### Scenario: A plan is drafted, approved in the conversation, and executed from the TUI

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
- **THEN** none of them render in the stream

#### Scenario: The rollup of the turn includes what its sub-agents spent

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

### Requirement: The just-sent message can be retracted for editing before any output

The chat MUST let the user retract the just-sent message for editing while a turn is in flight and the assistant produced nothing. Nothing means no text delta, no tool part, and no card part: only the empty assistant placeholder.

The retract MUST do these steps in order:

1. Claim the store generation token.
2. Abort the turn, and await the settlement of the turn.
3. Make sure again that the turn produced nothing.
4. Remove the stored user turn from the pg thread with the tail-turn retract of the harness.
5. Remove the user message and the assistant placeholder from the live store. Then seed the composer with the original text, with the cursor at the end.

The visible half MUST land as one step after the durable half, never split across it. A transcript that dropped the message while the composer is still empty is a half-applied state that the user cannot read. The seed MUST NOT occur when the composer is no longer empty. Thus the restoration never overwrites text that the user typed during the retract.

The durable retract MUST NOT run when the opening of the aborted turn did not land, as the `opened` flag of the outcome gives. The tail of the thread is then an earlier turn that must not go.

A database fault of the retract itself MUST show as an error notice while the composer holds the seeded text. The failed removal MUST stay pending, and the next send on that thread MUST retry it one time. A second failure MUST let the send continue, thus it never blocks the conversation.

The retry MUST first read the tail of the thread again. It removes the tail only when the tail still holds no assistant row, only the user message and the context records of that turn. The fault that scheduled the retry cannot tell a retract that rolled back from a retract whose commit landed but lost its acknowledgment. A blind retry in the second case would delete a real, answered turn.

When the first delta or part lands, the retract affordance MUST become inert. Output can land between the trigger and the settlement of the abort. Then the action MUST become a plain interrupt with a notice, and the message stays. A plain interrupt MUST NOT retract, and the kept user message stays context for the next turn.

#### Scenario: Retract-and-edit round-trips

- **WHEN** the user sends a message and retracts before any output
- **THEN** the transcript shows nothing from the attempt, the composer holds the original text, and the pg thread holds no orphan turn
- **AND** a new send gives exactly one user message in the thread

#### Scenario: The gate closes on the first delta

- **WHEN** the first text delta or tool part of the assistant arrives
- **THEN** the retract affordance is inert, and only the interrupt stays available

#### Scenario: A racing delta downgrades the retract

- **WHEN** output lands after the retract starts but before the abort settles
- **THEN** the message stays, a notice gives the reason of the downgrade, and nothing goes from the store or the thread

#### Scenario: An opening that did not land skips the durable retract

- **WHEN** the opening of the aborted turn did not land, and the user retracts
- **THEN** the live store loses the message, the composer holds the text, and no thread turn goes

#### Scenario: A fault after the opening keeps the durable retract

- **WHEN** the close of the aborted turn faulted but its opening landed, and the user retracts
- **THEN** the durable retract runs, and the thread holds no row of that turn

#### Scenario: A durable retract fault keeps the text of the user

- **WHEN** the tail-turn retract of the harness returns a database fault
- **THEN** an error notice shows, the composer still holds the original text, and the removal stays pending for that thread

#### Scenario: The next send heals a failed removal

- **WHEN** a pending removal exists for the thread and the user sends again
- **THEN** the removal runs again before the new turn stores its opening, and a second failure lets the send continue

#### Scenario: The heal removes a tail with context records

- **WHEN** a pending removal exists, and the tail holds the user message and its context records
- **THEN** the retry removes that tail

#### Scenario: The heal declines when the orphan is already gone

- **WHEN** a pending removal exists, but the tail of the thread is an answered turn, because the faulted retract had in fact committed
- **THEN** nothing goes, and the send continues

#### Scenario: Typing during a retract survives it

- **WHEN** the user types into the composer while the durable removal of the retract is in flight
- **THEN** the typed text stays, and the original message does not replace it

### Requirement: A chat turn append names the person who sent it

The shared turn engine MUST give the author of the turn to `runChatTurn` of the harness. The harness stores the author on the row of the user message, in the opening of the turn. The author is the email of the signed-in identity of the cli. One identity rule answers "who is the user" for the cli, thus a transcript and a provenance document name the same person.

The engine MUST read the identity when the turn OPENS, before the agent loop. The author is who sent the message, thus the value comes from the moment of the message. A sign-out during a turn MUST NOT erase the author of that turn. A sign-in or a sign-out between two turns changes the author of the next turn, thus no stale value survives.

Each failure of the identity read MUST give no author. The read fails in each of these conditions:

- The cli holds no stored session.
- The cli cannot read the stored session, or the schema refuses it.
- The token does not decode, or it holds no email.

An absent author MUST be absent, never an empty string and never a placeholder. Thus it never reads as a real sender. The absence rides the normal path: it ends no turn and it reports no error.

The opening MUST carry the author that the read gave, and no different author. The opening lands before the agent loop. Thus a turn that the user interrupts and a turn that fails keep the author. A turn that the engine refuses before the agent loop stores nothing, thus it stores no author.

Both chat surfaces drive the one engine. Thus the TUI chat and the dev REPL stamp the author under one rule, and neither gives its own.

The identity of the agent session MUST NOT change. It stays the fixed local value that the ask grants and the harness scope key on. The author of the turn and the identity of the session are two different facts.

#### Scenario: A signed-in user stamps the turn

- **WHEN** a signed-in user sends a message and the turn completes
- **THEN** the opening carries the email of that user as the author of the turn

#### Scenario: A signed-out user stamps nothing

- **WHEN** a user with no stored session sends a message
- **THEN** the opening carries no author, and the turn completes the same as a signed-in turn

#### Scenario: A session that gives no email stamps nothing

- **WHEN** the stored session gives no email, because it does not read, does not parse, does not decode, or holds no email claim
- **THEN** the opening carries no author, and no error reaches the surface

#### Scenario: An interrupted turn keeps its author

- **WHEN** a signed-in user interrupts a turn after the reply started
- **THEN** the opening of that turn carries the same author as a completed turn

#### Scenario: A failed turn keeps its author

- **WHEN** the agent loop of a signed-in user throws
- **THEN** the opening of that turn carries that author, and no round carries it

#### Scenario: The next turn reads the identity again

- **WHEN** the signed-in identity changes between two turns of one engine
- **THEN** each turn stamps the identity of its own moment, and no turn stamps a held value

#### Scenario: One engine stamps both surfaces

- **WHEN** the TUI chat and the dev REPL each run a turn for the same signed-in user
- **THEN** both openings carry that one author, and neither surface passes an author of its own
