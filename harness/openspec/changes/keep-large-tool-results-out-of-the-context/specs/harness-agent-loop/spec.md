## ADDED Requirements

### Requirement: The loop cuts a long tool result before the result joins the transcript

The loop MUST measure the text of each result that `dispatchTool` makes, before the result joins a `tool` message. The text is the text that the model reads:

- The text of a `json` or an `error-json` result is the JSON text of its value.
- The text of a `text` or an `error-text` result is its value.
- The text of a `content` result is its text part.

A denial result MUST keep its text, because a denial ends the turn with the words of the user. The loop MUST count a length in UTF-16 code units, the unit of a JavaScript string length. This requirement calls such a unit a character.

When the text is longer than the cap of 32,768 characters, the loop MUST replace the text with an excerpt. The excerpt MUST hold these parts, in this order:

- a line that states the cut, the length of the text, the cap, and the lengths of the two parts that it shows
- when the loop kept the text, a line that gives the reference, the length of the kept text, and the tool `read_tool_output`
- the first 4,096 characters of the text
- a marker line that gives the count of the characters that the excerpt does not show
- the last 8,192 characters of the text

When the loop did not keep the text, the first line MUST state that the rest is not kept. A cut point MUST NOT split a surrogate pair.

A `json` or a `text` result MUST become a `text` result with the excerpt. An `error-text` or an `error-json` result MUST become an `error-text` result with the excerpt. A `content` result MUST keep its file parts after the excerpt, thus a picture keeps its placement. The cut MUST NOT change the outcome of `tool-finished`.

The cut MUST run in `dispatchTool`, the one function that makes the result of a dispatched call. Thus both dispatch paths and each segment of a conversation obey one rule, and no tool carries its own code for the cut. For a step-mode tool, the cut runs inside the durable step of the call. Thus the step output holds the excerpt, and a replay gives the same excerpt.

The excerpt MUST be a function of the text, the reference, and the decision to keep the text. Thus a replay of a workflow-mode tool, which runs the tool again, gives the same bytes.

#### Scenario: A result at the cap stays whole

- **GIVEN** a tool whose result has a JSON text of 32,768 characters
- **WHEN** the loop dispatches the call
- **THEN** the result is the `json` result with no change

#### Scenario: A long result becomes an excerpt

- **GIVEN** a `read_file` result with a JSON text of 262,200 characters, and a run with no store
- **WHEN** the loop dispatches the call
- **THEN** the result is a `text` result that starts with the line of the cut, and that line states that the rest is not kept
- **AND** the excerpt holds the first 4,096 and the last 8,192 characters, and its marker line gives the count 249,912

#### Scenario: The end of a failed command stays visible

- **GIVEN** an `execute_command` result with a stdout of 500,000 characters and a stderr that ends with a traceback
- **WHEN** the loop cuts the result
- **THEN** the excerpt ends with the traceback and the stream flags of the result

#### Scenario: An error result stays an error

- **GIVEN** a tool that throws an error with a message of 50,000 characters
- **WHEN** the loop dispatches the call
- **THEN** the result is an `error-text` result with the excerpt, and `tool-finished` reports the outcome `error`

#### Scenario: A picture keeps its placement

- **GIVEN** a provider that carries a picture in a tool result, and a result with a picture and a JSON text of 40,000 characters
- **WHEN** the loop cuts the result
- **THEN** the `content` result holds the excerpt and then the picture

#### Scenario: A replay gives the stored excerpt

- **GIVEN** a durable run whose step-mode tool gave a result of 100,000 characters
- **WHEN** the workflow replays
- **THEN** the step output gives the same excerpt, and the tool does not run again

### Requirement: The loop keeps the text of a cut result in an optional store

`RunAgentOptions` MUST accept an optional `toolOutputStore`, the same way as `usageRecorder`. The store is an interface of the loop layer. `put` keeps one text, and `get` gives the kept text of one reference in one analysis. The error type of each method MUST be `DomainError`. The loop MUST NOT know the realization of the store.

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

A `put` MUST be an upsert on the analysis id and the reference. Thus a workflow-mode tool, which runs again on a replay, writes the same row again. The excerpt MUST NOT depend on the outcome of the `put`. When a `put` gives an `err`, the loop MUST log one warn with the tool name and the reference, and the run continues.

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

- **GIVEN** a durable run whose workflow-mode tool gave a long result
- **WHEN** the workflow replays
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
