## Purpose

Give a host the input, the result, and the error of each tool call. Then a person can expand a call and read what it got and what it gave. Each value is bounded and carries no secret, because it leaves the server and it stays in the stored transcript.

## ADDED Requirements

### Requirement: A tool call carries its input, its result, and its error

The contracts MUST export the type `ToolCallValue` `{ text: string; cut: boolean }`. `text` is the shown text of one value of a call. `cut` is true when the cap cut the text.

`ToolStartedEvent` MUST have the optional field `input`. `ToolFinishedEvent` and `ToolCallPart` MUST have the optional fields `input`, `result`, and `error`. Each field is a `ToolCallValue`. The fields `toolName`, `outcome`, `detail`, and `durationMs` MUST NOT change, thus a client that does not read the new fields works as before.

The loop MUST fill the fields as follows:

- The `tool-started` of each call gives `input`.
- The `tool-finished` of a call with the outcome `ok` gives `input` and `result`.
- The `tool-finished` of a call with the outcome `error` gives `input` and `error`. A call that the call policy refused is such a call, and its `error` is the text of the refusal.
- The `tool-finished` of a call that the user denied gives `input` only. A denial is a decision of the person, not an error.

The shown text of a string input or a string result is the string itself. The shown text of each other input and result is the JSON text of the value. The shown text of an error is the error text that the model reads, before the loop cuts that text for the model. A value that cannot serialize, for example a cycle, gives no value, and the call runs as before.

The values ride on the events of the tool adapter and of the call policy. The calls that a `run_script` script makes give no values.

#### Scenario: A successful call carries its input and its result

- **GIVEN** a tool that gets `{ "path": "data/a.csv" }` and gives `{ "rows": 3 }`
- **WHEN** the loop runs the call
- **THEN** the `tool-started` event gives the `input` `{"path":"data/a.csv"}` with `cut` false
- **AND** the `tool-finished` event gives the same `input` and the `result` `{"rows":3}` with `cut` false, and no `error`

#### Scenario: A failed call carries its error

- **GIVEN** a tool whose call fails with the text `file not found: data/b.csv`
- **WHEN** the loop runs the call
- **THEN** the `tool-finished` event gives the `input` and no `result`
- **AND** the `error` is the error text that the model reads, and that text holds `file not found: data/b.csv`

#### Scenario: A refused call carries the refusal

- **GIVEN** a call that the call policy refuses
- **WHEN** the loop emits its events
- **THEN** the `tool-finished` event has the outcome `error`, and its `error` is the text of the refusal

#### Scenario: A denied call carries its input only

- **GIVEN** a call that the user denies
- **WHEN** the loop emits its events
- **THEN** the `tool-finished` event has the outcome `denied`, its `input`, and no `result` and no `error`

### Requirement: The emit site makes each value one time, with a cap and a mark

The loop MUST make each value at the emit site, one time for each event, and never at a host. A JSON value gets the field-name rule of "No secret leaves the server in a value" first. Then each string of the JSON value gets steps 1 and 2 before the serialization, thus no rule meets a JSON escape. An error text that parses as a JSON object is a JSON value, because the adapter writes the error of a tool as JSON. Each other text gets steps 1 and 2 directly. Step 3 runs on the shown text. The loop MUST obey the steps in this order:

1. Remove each control character except the tab, the line feed, and the carriage return.
2. Remove each secret that the text rules of "No secret leaves the server in a value" match.
3. Cut a text that is longer than 8,192 UTF-16 code units.

A cut text MUST keep its first 3,072 code units and its last 5,120 code units, with one marker line between them. Thus a cut text holds 8,192 code units and the marker line. The marker line states the count of the code units that it does not show. A cut MUST NOT divide a surrogate pair. A cut value MUST have `cut` true, and each other value MUST have `cut` false.

The control characters go first, thus a control byte inside a secret cannot stop a pattern. The secret removal comes before the cut, thus a secret cannot pass when the cut divides it. The shown text of a value can thus differ from the text that the model reads.

#### Scenario: A long result is cut and marked

- **GIVEN** a tool that gives a string of 50,000 characters
- **WHEN** the loop emits its `tool-finished`
- **THEN** the `result` has `cut` true
- **AND** its text holds the first 3,072 and the last 5,120 characters of the string, with the marker line between them

#### Scenario: A short value is not cut

- **GIVEN** a tool input whose JSON text has 200 characters
- **WHEN** the loop emits the `tool-started`
- **THEN** the `input` holds the whole JSON text, and `cut` is false

### Requirement: No secret leaves the server in a value

Before a value leaves the loop, the harness MUST replace each of these with a redaction marker:

- each secret format that `redactSecrets` matches, for example an `sk-ant-` key, a GitHub token, a JWT, a `Bearer` token, or a connection string
- the value of each object field whose name ends with a secret word, at any depth of an input or a result. The comparison ignores the case, `_`, and `-`. The secret words are `password`, `passwd`, `secret`, `secretkey`, `token`, `apikey`, `accesskey`, `privatekey`, `credential`, `credentials`, and `authorization`
- the value of each assignment `NAME=value` in a text whose name ends with a secret word. An example is `AWS_SECRET_ACCESS_KEY=...` in an environment value
- the value of each quoted field `"name": "value"` in a text whose name ends with a secret word. An example is a JSON object in an error message. A quoted value ends at its closing quote, and an escaped quote inside it does not end it

The rules for a field name, for an assignment, and for a quoted field MUST apply only to a value of a tool call. `redactSecrets` and the redaction of a user message MUST NOT change. A name that only holds a secret word, for example `max_tokens`, MUST NOT match, because its name does not end with the word.

#### Scenario: A token in an input does not leave the server

- **GIVEN** a tool input `{ "env": { "GITHUB_TOKEN": "ghp_<36 characters>" }, "cmd": "export API_KEY=abc123 && run" }`
- **WHEN** the loop emits the events of the call
- **THEN** the `input` of each event holds no `ghp_` token and no `abc123`
- **AND** the stored display of the call holds neither of them

#### Scenario: A password field in a result is removed

- **GIVEN** a tool that gives `{ "user": "ana", "password": "hunter2" }`
- **WHEN** the loop emits its `tool-finished`
- **THEN** the `result` holds `ana` and holds no `hunter2`

#### Scenario: A sequence and a token count pass unchanged

- **GIVEN** a tool that gives `{ "sequence": "ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT", "max_tokens": 100 }`
- **WHEN** the loop emits its `tool-finished`
- **THEN** the `result` holds the whole sequence and `"max_tokens":100`

### Requirement: The stored display keeps the values of a call

The display recorder MUST record the `input`, the `result`, and the `error` of a tool call on its tool-call part. The stored display MUST keep the three fields, and the replay MUST give them. A call whose stream gave a value MUST give the same value after a reload, thus the transcript read `GET {T}/messages` of a host gives them.

A stored row that holds none of the three fields MUST still read. Its tool-call part MUST have no `input`, `result`, or `error` key.

The stream of a run MUST NOT carry the values. A step and the synthesis forward each loop event under `data-loop-event` as before, without the three values.

#### Scenario: A reload shows the input and the result

- **GIVEN** a turn with one call that got an input and gave a result
- **WHEN** the harness stores the turn and the replay reads it
- **THEN** the tool-call part of the replay holds the same `input` and `result` as the live part

#### Scenario: A reload shows the error of a failed call

- **GIVEN** a turn with one call that failed
- **WHEN** the harness stores the turn and the replay reads it
- **THEN** the tool-call part of the replay holds the outcome `error` and the `error` of the call

#### Scenario: An old row reads

- **GIVEN** a stored tool call with no `input`, no `result`, and no `error`
- **WHEN** the replay reads it
- **THEN** the tool-call part has none of the three keys

#### Scenario: The run stream does not carry the values

- **GIVEN** a step of a run whose agent calls a tool, and a synthesis that calls a lookup tool
- **WHEN** each forwards its loop events to the stream of the run
- **THEN** the forwarded events hold no `input`, `result`, or `error` value of the call
