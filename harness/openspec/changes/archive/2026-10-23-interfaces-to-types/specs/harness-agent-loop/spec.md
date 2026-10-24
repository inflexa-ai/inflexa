## MODIFIED Requirements

### Requirement: The loop keeps the text of a cut result in an optional store

`RunAgentOptions` MUST accept an optional `toolOutputStore`, the same way as `usageRecorder`. The store is a type of the loop layer. `put` keeps one text, and `get` gives the kept text of one reference in one analysis. The error type of each method MUST be `DomainError`. The loop MUST NOT know the realization of the store.

The loop MUST keep a text only when two conditions are true: the run has a store, and the agent declares `read_tool_output`. Then the loop MUST put a record before the result joins the transcript. The record holds these values:

- the analysis id of the session
- the reference
- the tool name and the tool call id
- the thread id of the session, only when the session has no run frame
- the kept text
- the length of the whole text

A run session carries the scope of the chat that started the run. Thus the loop MUST NOT give a thread id for a session with a run frame. A text of a run belongs to the analysis, and a text of a chat turn belongs to its thread.

The kept text MUST be the whole text when the text has at most 1,048,576 characters. A longer text MUST keep its first 524,288 and its last 524,288 characters. A marker line between the two parts MUST give the count of the dropped characters.

The key of a record MUST be `recordKeyFor` over the session, the invocation id of the run, and the tool step name of the call. The tool step name holds the tool call id. Under a run frame the key is the same on each replay, and in a chat turn it is a fresh id.

The reference MUST be `to_` and the first 20 hexadecimal characters of the SHA-256 hash of the key. The analysis id MUST be a part of the identity of a record. The data profile uses the same literal run id for each analysis. Thus only the analysis id keeps the records of two analyses apart.

A `put` MUST be an upsert on the analysis id and the reference. Thus a call that runs again on a replay or on a recovery writes the same row again. The excerpt MUST NOT depend on the outcome of the `put`. When a `put` gives an `err`, the loop MUST log one warn with the tool name and the reference, and the run continues.

When the run has no store, or the agent does not declare `read_tool_output`, the loop MUST keep nothing. The excerpt then states that the rest is not kept.

#### Scenario: The store gets the whole text

- **GIVEN** a run with a store, and an agent that declares `read_tool_output`
- **WHEN** a tool gives a result with a text of 100,000 characters
- **THEN** the store holds a record with the analysis id of the session, the whole text, and the length 100,000
- **AND** the second line of the excerpt gives the reference of that record

#### Scenario: A text of a chat turn names its thread

- **GIVEN** a chat session with the thread id `t-1` and no run frame, and a sub-agent loop of that turn
- **WHEN** each loop keeps a long result
- **THEN** each record carries the thread id `t-1`

#### Scenario: A text of a run names no thread

- **GIVEN** a run session whose scope carries the thread id of the chat that started the run
- **WHEN** a loop of the run keeps a long result
- **THEN** the record carries no thread id

#### Scenario: The record lands before the next request

- **GIVEN** a run with a store whose first reply calls a tool with a long result
- **WHEN** the loop sends the second model request
- **THEN** the store holds the record of that result

#### Scenario: An agent without the read tool keeps nothing

- **GIVEN** a run with a store, and an agent that does not declare `read_tool_output`
- **WHEN** a tool gives a long result
- **THEN** the store gets no `put`, and the excerpt states that the rest is not kept

#### Scenario: A replay writes the same record

- **GIVEN** a durable run whose step-mode call kept a long result, and a host that stopped before the step completed
- **WHEN** the step runs again on recovery
- **THEN** the loop puts the same reference and the same text, and the row does not change

#### Scenario: A failed put does not fail the run

- **GIVEN** a store whose `put` gives an `err`
- **WHEN** a tool gives a long result
- **THEN** the excerpt is the same as with a working store, the loop logs one warn, and the run continues

#### Scenario: A very long text keeps its start and its end

- **GIVEN** a result with a text of 3,000,000 characters
- **WHEN** the loop keeps the text
- **THEN** the kept text holds the first 524,288 characters, the marker line, and the last 524,288 characters
- **AND** the record holds the length 3,000,000
