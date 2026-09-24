## MODIFIED Requirements

### Requirement: The turn loop runs through the harness app-fn seam

Each turn MUST be one call of `runChatTurn` of the harness. The harness runs this sequence:

1. `prepareChatTurn`: the ownership gate, the title seed, the load of the analysis status, and the message assembly.
2. The agent resolution: `agents.forThread(threadType)` over the type that the preparation gives.
3. The store of the opening: the user message and the context records of the turn.
4. `runAgent`, with a round sink that stores each round when it completes.
5. The close: the outcome of the turn, and a failure note when the run failed.

The engine MUST give the harness the provider of the booted runtime, a turn-scoped abort signal, and the emit sink of the surface. It MUST give the resolver `agents`, and it MUST NOT give a pre-selected agent.

A type that the harness refuses (`unregistered_thread_type`) MUST end the turn as its own terminal outcome, distinct from a prepare failure. The harness never calls `runAgent` for it, and it stores nothing.

This call MUST live in ONE shared turn-engine module that both this REPL and the TUI chat consume. The REPL MUST NOT carry its own copy of the turn body.

The agent session MUST carry the thread id in its scope, thus a plan that runs from chat stamps `cortex_runs.thread_id`. The cli MUST NOT import the DBOS SDK in the chat path. It MUST NOT send raw SQL to a table of the harness there either.

#### Scenario: A turn round-trips the thread machinery

- **WHEN** a user sends a second message in the same chat
- **THEN** the assembled context holds the stored earlier turn in the token-budgeted window, with its context records
- **AND** the new turn lands in the same thread

#### Scenario: Runs from the chat carry the thread lineage

- **WHEN** the agent executes an approved plan during a chat
- **THEN** the `thread_id` of the run row is the thread id of the chat

#### Scenario: One turn engine serves both surfaces

- **WHEN** the REPL and the TUI each run a turn
- **THEN** both call the same exported turn-engine function, and neither carries a private copy of the turn

#### Scenario: A conversation thread resolves the conversation agent

- **WHEN** a turn runs on a thread whose type is `conversation`
- **THEN** the harness runs the agent that `agents.forThread("conversation")` resolves, and the turn continues as before

#### Scenario: A failed turn keeps its rounds

- **GIVEN** a turn whose run throws after one round
- **WHEN** the REPL runs it
- **THEN** the thread holds the opening, that round, and the failure note, and the REPL prints the failure

#### Scenario: An unregistered thread type refuses the turn before the loop

- **WHEN** a turn runs on a thread whose type has no registered agent in this build
- **THEN** the engine returns the unresolved-agent outcome with the thread type
- **AND** `runAgent` never runs, the thread gets no row, and the REPL prints the refusal to stderr
