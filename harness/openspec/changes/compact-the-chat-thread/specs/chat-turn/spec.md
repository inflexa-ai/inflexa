## MODIFIED Requirements

### Requirement: A turn stores its opening before the first model request

Before the first model request of a turn, the turn MUST write its opening in one transaction. The opening holds the user message and each context record that the preparation added. The same transaction MUST add the turn record with the status `open`. When that write fails, the next write of the turn stores the opening first.

The first request of the turn ends with the opening, in the same order. When the view of that request exceeds the budget, a compaction request comes directly after the opening (see the harness-agent-loop capability). Thus the stored thread holds each message that the harness sent.

The row of the user message carries the author of the turn and the display projection of the user message. A context record has no display projection.

#### Scenario: The opening lands before the model answers

- **GIVEN** a provider that reads the stored rows of the thread at its first call
- **WHEN** a turn runs
- **THEN** the rows end with the user message and the context records of the turn, and the turn record is `open`

#### Scenario: The opening carries the author

- **GIVEN** a turn with an author
- **WHEN** the thread is read back
- **THEN** the row of the user message carries the author, and no context record carries it

#### Scenario: A compaction request comes after the opening

- **GIVEN** a thread whose view and opening exceed the budget of the turn
- **WHEN** the turn sends its first model request
- **THEN** that request ends with the opening and then the compaction request, and the store holds the opening already

### Requirement: The turn stores each round when it completes

The turn MUST give `runAgent` a round sink. For each round, the sink MUST store the messages of the round and the display projection of the round in one transaction. The display projection holds the parts that the live events of the round carried. The two rounds of a compaction obey their own rule (see "The chat turn stores each compaction round").

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

## ADDED Requirements

### Requirement: The root loop of a chat turn compacts the conversation

`runChatTurn` MUST give the root loop a compaction policy (see the harness-agent-loop capability). The budget MUST be 150,000 estimated tokens by default. A host MUST be able to pass a different budget with the optional parameter `conversationBudget`.

The policy of the turn MUST hold these values:

- The provider of the exchange comes from the provider factory of the host, over an emit sink that drops each text delta.
- The turn selects the variant of the exchange from the declared tools of the agent.
- On a `conversation` thread, the agent declares `update_working_memory`. The mask lets only that tool run, and the request asks for the memory edits first.
- A `report` thread reads a frozen copy of working memory, and its agent declares no `update_working_memory`. Its mask is `"none"`, and its request has only the summary step.
- The request asks for a summary in plain text that leaves out what working memory holds.
- A `report` thread keeps its first turn, the seed, in front of each view.

The summary gives these facts:

- the goals, and the current request of the person in its exact words
- the decisions, with their reasons
- the open questions
- the file paths and the run ids that the work uses
- the state of the work in progress

A compaction inside a turn puts the user message of that turn before the marker. Thus the summary carries that request.

After a marker, the turn MUST add a record of each kind that the new view holds no copy of. It MUST also add a record of each kind whose hash differs from the latest copy in the new view. After a summary marker, the new view holds no copy. Thus each kind comes back: the analysis context when it exists, the run activity, and the working memory on a `conversation` thread.

The sub-agent loops of the turn MUST get no policy.

#### Scenario: A host budget wins

- **GIVEN** a host that passes `conversationBudget: 2000`, and a thread whose view exceeds 2,000 tokens
- **WHEN** a turn runs
- **THEN** the root loop compacts before its first task request

#### Scenario: A small thread does not compact under the default budget

- **GIVEN** a host that passes no budget, and a thread whose view is 10,000 tokens
- **WHEN** a turn runs
- **THEN** no exchange runs, and the thread holds no marker

#### Scenario: The summary does not reach the surface

- **GIVEN** a turn whose root loop compacts
- **WHEN** the exchange replies with a summary
- **THEN** the emit sink of the host gets no text delta of the summary

#### Scenario: The working memory follows the summary

- **GIVEN** a `conversation` thread whose exchange adds a constraint to working memory
- **WHEN** the root loop sends the request after the marker
- **THEN** the request holds the summary marker, and then the context records, and the working-memory record holds the constraint

#### Scenario: A report turn keeps the seed and adds no working-memory record

- **GIVEN** a `report` thread whose root loop compacts
- **WHEN** the root loop sends the request after the marker
- **THEN** the request starts with the seed and then the summary marker, and no working-memory record follows the marker

#### Scenario: A report exchange runs no tool

- **GIVEN** a `report` thread whose root loop compacts
- **WHEN** the exchange calls a tool of the report agent
- **THEN** the tool does not run, and the call gets the error result of the mask `"none"`
- **AND** the request of the exchange has no memory step

#### Scenario: A sub-agent loop does not compact

- **GIVEN** a turn whose tool runs the planner
- **WHEN** the planner loop sends a request over the budget of the turn
- **THEN** the planner loop runs no exchange

### Requirement: The chat turn stores each compaction round

The round sink of the turn MUST store the two rounds of a compaction, each in one transaction: the exchange, and then the marker with its records. The exchange MUST carry no display projection. The marker round MUST carry the divider of the marker on the row of the marker (see the harness-thread-history capability).

The display recorder MUST NOT take the text of an exchange message as the text of a round. Thus the summary never shows as a reply of the assistant, live or after a reload.

After a marker round, the recorder MUST give the later rounds of the turn a new assistant id. The divider separates the rounds before it from the rounds after it. Thus the replay gives two assistant messages, and the two must not share an id.

The rows of a compaction belong to the turn that made them. A tail retract removes them with that turn, and the view then goes back to the previous marker. The host makes no new call for a compaction.

#### Scenario: A reload shows the divider between two rounds

- **GIVEN** a turn that compacts between its first and its second round
- **WHEN** `loadAll` reads the thread and the transcript replay runs
- **THEN** the replay gives the user message, an assistant message, the divider, and an assistant message
- **AND** the two assistant messages carry two different ids

#### Scenario: The summary is not a reply

- **GIVEN** a turn that compacts with a summary
- **WHEN** the transcript replay runs
- **THEN** no assistant message of the replay holds the text of the summary

#### Scenario: The next turn starts from the summary

- **GIVEN** a `conversation` thread whose last turn compacted
- **WHEN** the next turn is prepared
- **THEN** its messages start with the summary marker and its records, then the later rounds, and then the new opening

#### Scenario: A retract removes the compaction of the last turn

- **GIVEN** a thread whose last turn compacted after an earlier summary marker
- **WHEN** `retractLastTurn` removes the last turn
- **THEN** no row of the exchange or of the new marker remains, and the next turn starts from the earlier summary marker
