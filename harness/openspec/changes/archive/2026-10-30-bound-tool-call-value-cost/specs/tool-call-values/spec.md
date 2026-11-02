## MODIFIED Requirements

### Requirement: The emit site makes each value one time, with a cap and a mark

The loop MUST make each value at the emit site, one time for each event, and never at a host. A JSON value gets the field-name rule of "No secret leaves the server in a value" first. Then each string of the JSON value gets steps 1 and 2 before the serialization, thus no rule meets a JSON escape. An error text that parses as a JSON object is a JSON value, because the adapter writes the error of a tool as JSON. Each other text gets steps 1 and 2 directly. Step 3 runs on the shown text. The loop MUST obey the steps in this order:

1. Remove each control character except the tab, the line feed, and the carriage return.
2. Remove each secret that the text rules of "No secret leaves the server in a value" match.
3. Cut a text that is longer than 8,192 UTF-16 code units.

A cut text MUST keep its first 3,072 code units and its last 5,120 code units, with one marker line between them. Thus a cut text holds 8,192 code units and the marker line. The marker line states the count of the code units that it does not show. A cut MUST NOT divide a surrogate pair. A cut value MUST have `cut` true, and each other value MUST have `cut` false.

A text longer than 24,576 code units MUST get steps 1 and 2 only on two windows: its first 11,264 and its last 13,312 code units. A JSON value whose JSON text is longer than 24,576 code units MUST get them only on a copy of each end of the value. Each copy holds at least the same window of the JSON text. Thus the cost of steps 1 and 2 does not grow with the size of a value. Each window reaches 8,192 code units past its shown part. As a result, the steps remove a secret at the edge of a shown part when the secret is shorter than 8,192 code units. The marker line of such a text states the length of the original text less the code units that it shows.

The control characters go first, thus a control byte inside a secret cannot stop a pattern. The secret removal comes before the cut, thus a secret cannot pass when the cut divides it. The shown text of a value can thus differ from the text that the model reads.

#### Scenario: A long result is cut and marked

- **GIVEN** a tool that gives a string of 50,000 characters
- **WHEN** the loop emits its `tool-finished`
- **THEN** the `result` has `cut` true
- **AND** its text holds the first 3,072 and the last 5,120 characters of the string, with the marker line between them

#### Scenario: A very long value is cut at a bounded cost

- **GIVEN** a tool that gives a JSON array whose JSON text has 10,000,000 characters
- **WHEN** the loop emits its `tool-finished`
- **THEN** the `result` holds the first 3,072 and the last 5,120 characters of that JSON text, with the marker line between them
- **AND** steps 1 and 2 read only the two windows of the JSON text

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

For an assignment and for a quoted field, a quoted value with no closing quote holds the rest of the text, because a cut text can end inside a secret.

The rules for a field name, for an assignment, and for a quoted field MUST apply only to a value of a tool call. `redactSecrets` and the redaction of a user message MUST NOT change. A name that only holds a secret word, for example `max_tokens`, MUST NOT match, because its name does not end with the word.

#### Scenario: A token in an input does not leave the server

- **GIVEN** a tool input `{ "env": { "GITHUB_TOKEN": "ghp_<36 characters>" }, "cmd": "export API_KEY=abc123 && run" }`
- **WHEN** the loop emits the events of the call
- **THEN** the `input` of each event holds no `ghp_` token and no `abc123`
- **AND** the stored display of the call holds neither of them

#### Scenario: A secret with no closing quote is removed

- **GIVEN** a tool error text `run --env API_KEY="abc123` with no closing quote
- **WHEN** the loop emits its `tool-finished`
- **THEN** the `error` holds no `abc123`

#### Scenario: A password field in a result is removed

- **GIVEN** a tool that gives `{ "user": "ana", "password": "hunter2" }`
- **WHEN** the loop emits its `tool-finished`
- **THEN** the `result` holds `ana` and holds no `hunter2`

#### Scenario: A sequence and a token count pass unchanged

- **GIVEN** a tool that gives `{ "sequence": "ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT", "max_tokens": 100 }`
- **WHEN** the loop emits its `tool-finished`
- **THEN** the `result` holds the whole sequence and `"max_tokens":100`
