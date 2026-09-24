## ADDED Requirements

### Requirement: The harness runs the whole chat turn

The harness MUST give one app function, `runChatTurn(deps, params)`, that runs one chat turn from the user input to the outcome. The function MUST do these steps in this order:

1. Prepare the turn with `prepareChatTurn`.
2. Resolve the agent with `agents.forThread` over the thread type that the preparation gives.
3. Store the opening of the turn.
4. Run `runAgent` with a round sink that stores each round.
5. Close the turn with its outcome.

The deps give the pool, the agent resolver, the logger, and the provenance seam. The host gives only these transport values:

- the emit sink of its surface
- the abort signal of the turn
- a factory that makes the provider of the turn over an emit sink
- the usage recorder
- the approval binding, when the surface can ask the user
- the author of the user message, and the start time of the turn

A host can also pass a cache policy for the root loop (see "The root loop of a chat turn caches its prefix for 1 hour").

A host MUST NOT run the steps itself. Thus each host stores the same rows, and a change of the turn reaches each host with no change of the host.

The function MUST give one of these results:

- `prepare_failed`, with the cause, when the preparation throws
- `not_found`, when a different analysis owns the thread
- `agent_unresolved`, with the thread type, when the resolver refuses the type
- `ran`, with the outcome, `opened`, the store error when there is one, the duration, the turn usage, and the final text

A turn that ends before the run writes no row and no turn record.

#### Scenario: A host runs a turn with one call

- **WHEN** a host calls `runChatTurn` with its emit sink, its signal, its provider factory, and its usage recorder
- **THEN** the thread holds the opening, each round, and a closed turn record, and the host wrote no row itself

#### Scenario: A refused thread type writes nothing

- **GIVEN** a thread whose type has no registered agent
- **WHEN** `runChatTurn` runs a turn on it
- **THEN** the result is `agent_unresolved` with the thread type, and the turn wrote no row and no turn record

#### Scenario: A thread of a different analysis is not found

- **GIVEN** a thread that a different analysis owns
- **WHEN** `runChatTurn` runs a turn on it
- **THEN** the result is `not_found`, and the thread did not change

### Requirement: A turn stores its opening before the first model request

Before the first model request of a turn, the turn MUST write its opening in one transaction. The opening holds the user message and each context record that the preparation added. The same transaction MUST add the turn record with the status `open`. When that write fails, the next write of the turn stores the opening first.

The first request of the turn ends with the opening, in the same order. Thus the stored thread holds each message that the harness sent.

The row of the user message carries the author of the turn and the display projection of the user message. A context record has no display projection.

#### Scenario: The opening lands before the model answers

- **GIVEN** a provider that reads the stored rows of the thread at its first call
- **WHEN** a turn runs
- **THEN** the rows end with the user message and the context records of the turn, and the turn record is `open`

#### Scenario: The opening carries the author

- **GIVEN** a turn with an author
- **WHEN** the thread is read back
- **THEN** the row of the user message carries the author, and no context record carries it

### Requirement: The per-turn context is a record after the user message

The preparation MUST put the per-turn context after the user message of the turn, as `user` messages. Each message is a context record of one kind:

- `analysis-context`: the analysis context of the host, when it is not null and not empty.
- `run-activity`: the Run Activity render.
- `working-memory`: the working-memory render. A `report` thread gets no record of this kind.

The order of the records MUST be: analysis context, run activity, working memory. The text of a record MUST start with the tag of its kind in square brackets, on its own line. An empty working memory MUST give a record that states that the memory is empty.

A record MUST NOT be a `system` message. The agent writes the working memory from data that it read, and the harness does not trust that data. Also, Claude Sonnet 5 refuses a `system` message inside the conversation.

The preparation MUST add a record of a kind only in two conditions:

- The history window holds no record of that kind.
- The hash of the new text differs from the hash of the latest record of that kind in the window.

Thus a turn with no change adds no record, and the prefix of the next request stays byte-identical to the stored rows.

A record carries its kind and its hash in the harness namespace, and it is a synthetic message (see the ai-sdk-message-storage capability). Thus it opens no turn, and the display skips it.

#### Scenario: A first turn gets each record after the user message

- **GIVEN** a `conversation` thread with no stored record, and a host with no analysis context
- **WHEN** a turn is prepared
- **THEN** the messages end with the user message, then the run-activity record, then the working-memory record

#### Scenario: A turn with no change adds no record

- **GIVEN** a thread whose last turn stored each kind of record, and no later change of the run activity or the working memory
- **WHEN** the next turn is prepared
- **THEN** the messages end with the user message, and each earlier message is byte-identical to its stored row

#### Scenario: A changed memory adds one record

- **GIVEN** a thread whose last turn stored each kind of record, and a working memory that changed after that turn
- **WHEN** the next turn is prepared
- **THEN** the messages end with the user message and one working-memory record with the new render

#### Scenario: An evicted record is added again

- **GIVEN** a thread whose history window no longer holds a working-memory record
- **WHEN** a turn is prepared
- **THEN** the turn adds a working-memory record, although the memory did not change

#### Scenario: A report turn gets no working-memory record

- **WHEN** a turn is prepared on a `report` thread
- **THEN** the turn adds no working-memory record

#### Scenario: An empty memory replaces an old copy

- **GIVEN** a thread whose window holds a working-memory record with entries, and a working memory that is now empty
- **WHEN** the next turn is prepared
- **THEN** the turn adds a working-memory record that states that the memory is empty

### Requirement: The turn stores each round when it completes

The turn MUST give `runAgent` a round sink. For each round, the sink MUST store the messages of the round and the display projection of the round in one transaction. The display projection holds the parts that the live events of the round carried.

A store fault MUST NOT stop the turn. The turn keeps the rows of the failed write. The next write of the turn stores them first, in its transaction and in order. Thus a row never lands before an earlier row of its turn.

The result MUST carry `opened`, which is true when the opening landed. It MUST carry the store error when rows of the turn did not land by the close.

A host MUST NOT append a record of its own to a thread while a turn of that thread is `open`. Such a record would land between two rounds, and the stored order would then differ from the sent order.

#### Scenario: A long turn keeps its rounds after a failure

- **GIVEN** a turn whose provider answers two rounds with tool calls and then fails with HTTP 401
- **WHEN** the turn ends
- **THEN** the thread holds the opening, the two rounds, and the failure note, in this order

#### Scenario: A store fault is written again with the next round

- **GIVEN** a turn whose store refuses the write of its first round one time
- **WHEN** the second round completes
- **THEN** one transaction stores the first round and then the second round, and the result carries no store error

#### Scenario: An opening that never lands is reported

- **GIVEN** a store that refuses each write of the turn
- **WHEN** the turn ends
- **THEN** the result carries `opened: false` and the store error

### Requirement: A turn closes with one outcome

A turn MUST have one status: `open` while it runs, then `done`, `aborted`, or `failed`. The close MUST set the status one time, in the transaction that stores the last rows of the turn.

The turn MUST select the status from the run:

- A run that returns with the finish reason `aborted` is `aborted`.
- A run that returns with a different finish reason is `done`. This includes the finish reasons `content-filter`, `max_iterations`, and `denied`.
- A run that throws an `AbortError` while the signal of the turn is aborted is `aborted`.
- A run that throws a different error is `failed`.

The close MUST store the usage rollup of the turn and its duration on the turn record. A rollup that reports no quantity is stored as absent. The duration counts from the start time that the host gives, or from the call when the host gives none.

A turn that no process closes, for example after a crash, stays `open`. The harness MUST NOT guess its outcome. When the write of the close fails, the record also stays `open`, and the result carries the store error.

#### Scenario: A clean turn closes as done

- **GIVEN** a turn whose model answers in text after one tool round
- **WHEN** the turn ends
- **THEN** the turn record is `done`, with the rollup of the turn and its duration

#### Scenario: A filtered reply closes as done

- **GIVEN** a turn whose model stops with the finish reason `content-filter`
- **WHEN** the turn ends
- **THEN** the turn record is `done`, and the outcome carries the finish with that reason

#### Scenario: An interrupt closes as aborted

- **GIVEN** a turn that the user aborts before the model gives output
- **WHEN** the turn ends
- **THEN** the thread holds the opening, and the turn record is `aborted`

#### Scenario: A thrown abort closes as aborted

- **GIVEN** a turn whose run throws an `AbortError` after the user aborts the signal
- **WHEN** the turn ends
- **THEN** the turn record is `aborted`, and the result carries no failure

### Requirement: A failed turn tells the model what occurred

When a turn fails, the close MUST append a failure note after the stored rounds. The note is a synthetic record message, thus it opens no turn, and the display shows it as a `system` message. The note MUST give the reason of the failure. It MUST also state that the rounds before it ran.

The reason MUST be a short text that the harness makes from the class of the error:

- A `suspend` error gives the suspend reason of the host, for example `payment_required`.
- An `auth` provider error gives a fixed text that the model endpoint refused the credential.
- A different provider error gives a fixed text that the model request failed.
- A different error gives a fixed text that the turn stopped on an internal error.

The reason MUST NOT hold the message of the error. An error message can hold a secret or a path of the host, and each later turn sends the note to the model provider.

Before the turn stores the last round, the loop answers each unanswered tool call of that round with the not-run result (see the harness-agent-loop capability). Thus the next turn continues from the stored rounds.

The result MUST carry the error as `cause`. Thus a host reads a suspension with `suspensionOfFailure`.

#### Scenario: A 401 keeps the work and adds a note

- **GIVEN** a turn whose third model request fails with an `auth` provider error
- **WHEN** the turn ends
- **THEN** the thread holds the opening, two rounds, and a note with the credential reason, and the turn record is `failed` with the same reason

#### Scenario: A suspend error gives the reason of the host

- **GIVEN** a turn whose model request fails with a `suspend` error with the reason `payment_required`
- **WHEN** the turn ends
- **THEN** the note and the turn record give the reason `payment_required`, and the status of the analysis does not change

#### Scenario: The note holds no error text

- **GIVEN** a turn that fails with an error whose message holds a URL and a key
- **WHEN** the turn ends
- **THEN** the note and the turn record hold the fixed reason, and no part of the error message

#### Scenario: The next turn continues from the stored rounds

- **GIVEN** a thread whose last turn failed after two rounds
- **WHEN** the next turn is prepared
- **THEN** its messages start with each stored row of the failed turn, byte-identical, the note included

### Requirement: The root loop of a chat turn caches its prefix for 1 hour

`runChatTurn` MUST run the root conversation loop with the cache policy `{ ttl: "1h" }`, through `RunAgentOptions.promptCache`. A host MUST be able to pass a different policy with the optional parameter `promptCache`, for example `{ ttl: "5m" }` or `"off"`.

A person can reply 5 to 60 minutes after the last reply. A 1-hour entry stays in the cache for that gap, and a 5-minute entry does not. A 1-hour write costs 2 times the base input price, and a 5-minute write costs 1.25 times.

The policy rides on the run, not on the provider configuration. Thus it reaches only the root loop, and each loop takes its policy from its own run options. Each other loop MUST keep `DEFAULT_PROMPT_CACHE`, which is 5 minutes:

- the planner
- the analogy report
- the literature reviewer
- each workflow loop

The requests of such a loop start less than 5 minutes apart, thus a 1-hour write would cost more than it saves.

#### Scenario: The root loop writes 1-hour entries

- **GIVEN** a turn whose host passes no cache policy
- **WHEN** the root loop sends a request
- **THEN** the system prompt and the last message of the request carry the 1-hour cache directive

#### Scenario: A host policy wins

- **GIVEN** a host that passes `promptCache: { ttl: "5m" }` to the turn
- **WHEN** the root loop sends a request
- **THEN** the request carries the 5-minute cache directive

#### Scenario: A sub-agent loop keeps 5 minutes

- **GIVEN** a turn whose tool runs the planner
- **WHEN** the planner loop sends a request
- **THEN** the request carries the 5-minute cache directive
