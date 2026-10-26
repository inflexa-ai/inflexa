## ADDED Requirements

### Requirement: A chat turn runs as a workflow

After its opening, a chat turn MUST run as a DBOS workflow. The workflow id MUST be the turn id. The workflow input MUST hold the ids and the settings of the turn: the turn, the analysis, the thread, the user, the thread type, the author, the start time, the cache policy, and the model reference. It MUST NOT hold the user input, the history, or a credential of a request. The first step of the workflow MUST load the view of the conversation.

#### Scenario: A crash during a tool round

- **GIVEN** a turn whose root agent completed one model call and one tool call, and then the host stopped
- **WHEN** the host starts again
- **THEN** the turn continues from the checkpoints, the tool does not run again, and the turn ends with one outcome

#### Scenario: The input holds no credential

- **WHEN** a host starts a turn with a session that holds a credential
- **THEN** the stored input of the turn workflow holds no part of that credential

### Requirement: A turn reads the live credential of its host

The harness MUST get the credential of a turn from a function that the host gives, by the turn id. The turn MUST ask at its start and after each wait. A sub-agent of the turn MUST ask for the credential of its root turn. When the function gives no credential, the turn MUST end as `failed` with the reason `interrupted`, before its next model call.

#### Scenario: A recovered turn of a host with a fixed credential

- **GIVEN** a host whose function gives the same credential for each turn
- **WHEN** a turn of that host recovers after a restart
- **THEN** the turn continues, and it ends with one outcome

#### Scenario: A recovered turn with no credential

- **GIVEN** a turn that ran when its host stopped, and a host function that gives no credential after the restart
- **WHEN** the host starts again and DBOS recovers the turn
- **THEN** the turn makes no model call, its record is `failed` with the reason `interrupted`, and its stream ends with an `error` frame

### Requirement: One turn runs on a thread at a time

The opening MUST refuse a turn on a thread that has an open turn record. The refusal MUST be `turn_in_progress`, and it MUST come before the turn writes a row.

#### Scenario: A second message during a turn

- **GIVEN** a thread with a turn that runs
- **WHEN** the host opens a second turn on that thread
- **THEN** the result is `turn_in_progress`, and the thread holds no row of the second turn

### Requirement: A host stops a turn by its id

A host MUST be able to stop a turn by its id. The process that runs the turn MUST stop the turn through the abort path of the loop. Thus the turn closes as `aborted`, with the partial text and the interruption note. When no process of the host runs the turn, the stop MUST cancel the workflow and close the turn record as `aborted`.

#### Scenario: A stop during the reply

- **WHEN** a host stops a turn while its reply streams
- **THEN** the turn record is `aborted`, the thread holds the partial reply with the interruption note, and the stream ends with a `finish` frame

### Requirement: Each write of a turn is safe to run again

The round writes, the close, and the rows of a compaction MUST be keyed by the turn and the round. A write that runs again after a crash MUST NOT store a row two times. The id and the duration of a compaction MUST come from the checkpoints of the turn.

#### Scenario: A crash after a round write

- **GIVEN** a round write that committed, and then the host stopped before its checkpoint
- **WHEN** the turn recovers and the write runs again
- **THEN** the thread holds each row of the round one time

## MODIFIED Requirements

### Requirement: The turn stores each round when it completes

The turn MUST give `runLoop` a round sink. For each round, the sink MUST store the messages of the round and the display projection of the round in one transaction. The display projection holds the parts that the frames of the round in the stream of the turn carry. The two rounds of a compaction obey their own rule (see "The chat turn stores each compaction round").

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

#### Scenario: A compaction stores two rounds

- **GIVEN** a turn whose root loop compacts between two rounds
- **WHEN** the turn ends
- **THEN** the thread holds the first round, the exchange, the marker with its records, and the second round, in this order

#### Scenario: A replayed round keeps its display parts

- **GIVEN** a round whose tool step completed before a crash
- **WHEN** the turn recovers and stores the round
- **THEN** the display projection of the round holds the tool part of that step

### Requirement: A turn closes with one outcome

A turn MUST have one status: `open` while it runs, then `done`, `aborted`, or `failed`. The close MUST set the status one time, in the transaction that stores the last rows of the turn.

The turn MUST select the status from the run:

- A run that returns with the finish reason `aborted` is `aborted`.
- A run that returns with a different finish reason is `done`. This includes the finish reasons `content-filter`, `max_iterations`, and `denied`.
- A run that throws an `AbortError` while the turn is stopped is `aborted`.
- A recovered turn with no live credential is `failed` with the reason `interrupted`.
- A run that throws a different error is `failed`.

The close MUST store the usage rollup of the turn and its duration on the turn record. A rollup that reports no quantity is stored as absent. The duration counts from the start time that the host gives, or from the start of the workflow when the host gives none.

A turn whose workflow is canceled closes as `aborted` through the stop of the host. When the write of the close fails, the record stays `open`, and the result carries the store error.

#### Scenario: A clean turn closes as done

- **GIVEN** a turn whose model answers in text after one tool round
- **WHEN** the turn ends
- **THEN** the turn record is `done`, with the rollup of the turn and its duration

#### Scenario: A filtered reply closes as done

- **GIVEN** a turn whose model stops with the finish reason `content-filter`
- **WHEN** the turn ends
- **THEN** the turn record is `done`, and the outcome carries the finish with that reason

#### Scenario: An interrupt closes as aborted

- **GIVEN** a turn that the user stops before the model gives output
- **WHEN** the turn ends
- **THEN** the thread holds the opening, and the turn record is `aborted`

#### Scenario: A thrown abort closes as aborted

- **GIVEN** a turn whose run throws an `AbortError` after the user stops the turn
- **WHEN** the turn ends
- **THEN** the turn record is `aborted`, and the result carries no failure

### Requirement: A chat turn opens before it runs

The harness MUST give an open call that takes the session and `{ analysisId, threadId, userInput }`. It MUST prepare the turn, resolve the agent of the thread type, store the opening, and start the turn workflow. It MUST give one of these results:

- `prepare_failed`, `not_found`, `agent_unresolved`, or `turn_in_progress`
- `started`, with the turn id and the resolved agent

A refusal MUST come back before the turn writes a row or a turn record. Thus a host can answer a refusal before it reads a stream.

#### Scenario: A thread of a different analysis is refused at the open

- **GIVEN** a thread that a different analysis owns
- **WHEN** a host opens a turn on it
- **THEN** the result is `not_found`, and the thread holds no row and no turn record of the turn
