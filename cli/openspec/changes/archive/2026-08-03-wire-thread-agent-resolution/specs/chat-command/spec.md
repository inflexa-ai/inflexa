# chat-command Delta

## MODIFIED Requirements

### Requirement: The turn loop runs through the harness app-fn seam

Each turn SHALL be exactly the harness's transport-free sequence: `prepareChatTurn` (ownership
check, title seed, analysis-status load, message assembly) → `runAgent` with the agent the harness
resolves for the thread's type, the booted runtime's provider, a turn-scoped abort signal, the
surface's emit sink, and the pass-through run step → `appendTurn` persisting
`[userMessage, ...loopOutput]` to the pg thread store. The engine SHALL resolve the agent between
prepare and run — `agents.forThread(threadType)` over the type the prepare ok result reports — never
from a pre-selected agent a caller passes in. A type the harness refuses (`unregistered_thread_type`)
SHALL end the turn as its own terminal outcome, distinct from a prepare failure: `runAgent` is never
called and nothing is persisted, matching the persistence contract that appends only on
`runAgent`-reaching paths. This sequence SHALL live in ONE shared turn-engine module consumed by both
this REPL and the TUI chat — the REPL SHALL NOT carry its own copy of the turn body. The agent
session SHALL carry the thread id in scope, so a plan executed from chat stamps
`cortex_runs.thread_id`. The cli SHALL NOT import the DBOS SDK or issue raw SQL against
harness-owned tables anywhere in the chat path.

#### Scenario: A turn round-trips the thread machinery

- **WHEN** a user sends a second message in the same chat
- **THEN** the assembled context contains the persisted prior turn (token-budgeted window), the working-memory render, and the analysis context, and the new turn is appended to the same thread

#### Scenario: Chat-launched runs carry thread lineage

- **WHEN** the agent executes an approved plan during a chat
- **THEN** the resulting run row's `thread_id` equals the chat's thread id

#### Scenario: One turn engine serves both surfaces

- **WHEN** the REPL and the TUI each run a turn
- **THEN** both drive the same exported turn-engine function; neither carries a private prepare→run→append sequence

#### Scenario: A conversation thread resolves the conversation agent

- **WHEN** a turn runs on a thread whose type is `conversation`
- **THEN** the engine hands `runAgent` the agent `agents.forThread("conversation")` resolves, and the turn proceeds as before

#### Scenario: An unregistered thread type refuses the turn before the loop

- **WHEN** a turn runs on a thread whose type has no registered agent in this build
- **THEN** the engine returns the unresolved-agent outcome naming the thread type, `runAgent` is never called, nothing is appended to the thread, and the REPL prints the refusal to stderr
