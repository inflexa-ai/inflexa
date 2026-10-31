## ADDED Requirements

### Requirement: A tool declares the view of its calls

A tool definition MUST declare a `view` decision: a `ToolCallView`, or the literal `"none"`. A definition with no decision MUST fail to typecheck, as a definition with no `describeCall` decision does. The decision is required because a tool shows only what it declares, and a forgotten view must be a build error, not a missing value.

A `ToolCallView` has three optional members:

- `input(input)` gives the shown input. It reads the input after the parse with the input schema of the tool.
- `result(input, result)` gives the shown result of a call with the outcome `ok`. It reads the ok value that the tool returned.
- `error: true` shows the error text of a call with the outcome `error`.

An absent member shows nothing. `"none"` MUST show no value. A packaged tool MUST NOT carry the sentinel: it carries a view, or it carries none. A member MUST be synchronous and pure, and it never reaches the model. A member that gives `undefined` gives no value. A member that throws, a value that cannot serialize, for example a cycle, and a value that breaks a rule of "A value has a kind" MUST give no value, and the call runs as before. An input that fails the parse gives no input value.

The refusal text of the call policy is not a value of the tool. Thus a refused call shows that text for each tool, `"none"` included, as "A tool call carries its input, its result, and its error" says.

#### Scenario: A tool with no view decision fails to compile

- **GIVEN** a tool definition that declares neither a view nor `"none"`
- **WHEN** the package is typechecked
- **THEN** the typecheck fails at that definition

#### Scenario: A tool that declares none shows no value

- **GIVEN** a tool that declares `view: "none"`
- **WHEN** the loop runs a call of the tool that succeeds
- **THEN** its `tool-started` and its `tool-finished` events carry no `input`, no `result`, and no `error`

#### Scenario: A tool shows only the members that it declares

- **GIVEN** a tool whose view declares `input` only
- **WHEN** the loop runs a call of the tool that succeeds
- **THEN** the `tool-finished` event carries the `input` and no `result`

#### Scenario: A failed view does not fail the call

- **GIVEN** a tool whose `result` member throws
- **WHEN** the loop runs a call of the tool
- **THEN** the call gives its result to the model as before, and the `tool-finished` event carries no `result`

### Requirement: A value has a kind

Each value of a call MUST be a `ToolCallValue` with a `kind`. A leaf value is one of these:

- `text`: a plain text, in `text`
- `json`: the JSON text of a value, in `text`. A host can parse it only when `cut` is false
- `code`: the source code of `language`, in `text`

Each leaf carries `cut`, which is true when the cap cut its text. The kind `fields` holds `fields`, an ordered list of at most 4 leaf values, each with a `name`. A name MUST have 1 to 40 characters of letters, digits, `_`, and `-`. A language MUST have 1 to 20 characters of lowercase letters, digits, `+`, `#`, `.`, and `-`. A `fields` value MUST NOT hold a `fields` value. A field whose leaf is `undefined` is left out, and a `fields` value with no field gives no value.

A member that gives a string gives a `text` leaf. A member that gives each other plain value gives a `json` leaf. The harness MUST export a helper for each kind. The `code` helper takes a language and a text. The `json` helper writes a string as a JSON string. The `fields` helper takes named leaves. A tool result that holds a field named `kind` MUST stay a `json` leaf: only a helper makes a kind.

#### Scenario: A host reads the kind of a value

- **GIVEN** a view whose `input` member gives the `code` leaf of a script in `javascript`
- **WHEN** the loop emits the `tool-started` of the call
- **THEN** its `input` has the kind `code`, the language `javascript`, and the text of the script

#### Scenario: A view gives named values

- **GIVEN** a view whose `result` member gives the fields `output`, a text, and `value`, a JSON value
- **WHEN** the loop emits the `tool-finished` of a call that succeeds
- **THEN** its `result` has the kind `fields`, with `output` of the kind `text` before `value` of the kind `json`

#### Scenario: A value that breaks a rule gives no value

- **GIVEN** a view whose `result` member gives 5 fields
- **WHEN** the loop emits the `tool-finished` of the call
- **THEN** the event carries no `result`

### Requirement: Only a root call carries values

The loop MUST make the values of a call only when the loop is a root loop, whose call path holds at most one entry. A call of a sub-agent MUST carry no value. A call that a `run_script` script makes MUST carry no value. No reader shows such a value: the display recorder and `applyChatFrame` keep the root frames only, and the activity of a sub-agent holds no value.

#### Scenario: A sub-agent call carries no value

- **GIVEN** a sub-agent that calls a tool with a view that declares `input` and `result`
- **WHEN** the sub-agent loop emits the events of the call
- **THEN** the events carry no `input`, no `result`, and no `error`

#### Scenario: A nested call of a script carries no value

- **GIVEN** a script that calls a script tool
- **WHEN** the nested call emits its events
- **THEN** the events carry no `input`, no `result`, and no `error`

### Requirement: The loop event carries the shown values and not the raw input

The loop event `tool-started` MUST NOT carry the raw input of a call. The loop events MUST carry the shown values in the fields `input`, `result`, and `error`, with the type `ToolCallValue`, as the frames do. `toChatFrame` copies each field by its name.

A reader of a call that needs a description of the call MUST read the `detail` of the event. The events of a refused call and of a denied call MUST carry the `detail` of the call. The events of the tool adapter carry it too.

#### Scenario: A started event holds no raw input

- **GIVEN** a call whose input holds the field `token` with a value
- **WHEN** the loop emits the `tool-started` of the call
- **THEN** no field of the event holds the raw input

#### Scenario: A refused call carries its detail

- **GIVEN** a call of a tool with a `describeCall` hook, which the call policy refuses
- **WHEN** the loop emits its events
- **THEN** the two events carry the detail of the call

### Requirement: The emit site removes the listed secret forms from a value

Before a value leaves the loop, the harness MUST replace each of these forms with a redaction marker:

- each secret format that `redactSecrets` matches, for example an `sk-ant-` key, a GitHub token, a JWT, a `Bearer` token, or a connection string
- a private-key block, from its `-----BEGIN ... PRIVATE KEY-----` line to its `-----END ... PRIVATE KEY-----` line. A begin line with no end line hides the rest of the text. An end line with no begin line before it hides the text from the start of the text, because a cut or a window can start inside a block
- the password of a URL, in `scheme://user:password@host`
- the password of a `-u user:password` or `--user user:password` option, for example of `curl`
- the value of each object field whose name ends with a secret word, at any depth of a JSON value
- the value of each assignment `NAME=value` whose name ends with a secret word, for example `AWS_SECRET_ACCESS_KEY=...`
- the value of each command flag `--name value` or `--name=value` whose name ends with a secret word, for example `--password hunter2`
- the value of each pair `name: value`, as in a header or in YAML, whose name ends with a secret word. The value ends at the end of its line or at a closing quote
- the value of each `Cookie` or `Set-Cookie` header, to the end of its line
- in a JSON array of strings, the element after a `--name` element whose name ends with a secret word, and the password of the element after a `-u` or `--user` element. Thus an argv array loses the same values as a command line in a text
- the value of each quoted field `"name": value` in a text whose name ends with a secret word. The value can be a quoted string, a number, or a bare word. A quoted value ends at its closing quote, and an escaped quote inside it does not end it

The secret words are `password`, `passwd`, `pass`, `secret`, `secretkey`, `token`, `apikey`, `accesskey`, `privatekey`, `credential`, `credentials`, `authorization`, and `cookie`. The comparison ignores the case, `_`, and `-`. A name MUST end with the word, thus `max_tokens` does not match. The word `pass` also marks a name such as `bypass` or `compass`. That costs a shown fact only, and it is accepted. A quoted value with no closing quote holds the rest of the text, because a cut text can end inside a secret. This applies to an assignment, a flag, and a quoted field.

The rules remove only these forms. A text can hold a secret in a different form. Thus the view of a tool is the control that keeps such data out of a value. Each rule of this list, except the `redactSecrets` formats, MUST apply only to a value and to the detail of a tool call. `redactSecrets` and the redaction of a user message MUST NOT change.

#### Scenario: A token in an input does not show

- **GIVEN** a shown input `{ "env": { "GITHUB_TOKEN": "ghp_<36 characters>" }, "cmd": "export API_KEY=abc123 && run" }`
- **WHEN** the loop emits the events of the call
- **THEN** the `input` of each event holds no `ghp_` token and no `abc123`
- **AND** the stored display of the call holds neither of them

#### Scenario: A command flag and a URL password do not show

- **GIVEN** a shown input `{ "command": "mysql --password hunter2", "url": "https://ana:hunter3@example.com/x" }`
- **WHEN** the loop emits the `tool-started` of the call
- **THEN** the `input` holds no `hunter2` and no `hunter3`, and it holds `ana`

#### Scenario: A curl password, a header, and a cookie do not show

- **GIVEN** a shown text `curl -u ana:hunter4 -H "X-Api-Key: k123"`, then the lines `Cookie: session=c456` and `db_password: p789`
- **WHEN** the loop emits the value
- **THEN** it holds no `hunter4`, no `k123`, no `c456`, and no `p789`, and it holds `ana`

#### Scenario: An argv array loses its secret values

- **GIVEN** a shown input `{ "argv": ["db", "--password", "hunter2", "-u", "ana:hunter3"] }`
- **WHEN** the loop emits the `tool-started` of the call
- **THEN** the `input` holds no `hunter2` and no `hunter3`, and it holds `db` and `ana`

#### Scenario: A quoted cookie header and a cookie field do not show

- **GIVEN** a shown input `{ "cmd": "curl -H \"Cookie: session=c1\"", "headers": { "Cookie": "session=c2", "Set-Cookie": "id=c3" } }`
- **WHEN** the loop emits the `tool-started` of the call
- **THEN** the `input` holds no `c1`, no `c2`, and no `c3`

#### Scenario: A key block cut by a window does not show its tail

- **GIVEN** a shown text longer than 24,576 code units, whose private-key block starts in the first window and ends in the last window
- **WHEN** the loop emits the value
- **THEN** the value holds no line of the key from either window

#### Scenario: A private key does not show

- **GIVEN** a shown result that holds a private-key block
- **WHEN** the loop emits the `tool-finished` of the call
- **THEN** the `result` holds no line of the key between its begin line and its end line

#### Scenario: A secret with no closing quote is removed

- **GIVEN** a shown error text `run --env API_KEY="abc123` with no closing quote
- **WHEN** the loop emits its `tool-finished`
- **THEN** the `error` holds no `abc123`

#### Scenario: A number in a password field does not show

- **GIVEN** a shown result text `{"password": 123456}`
- **WHEN** the loop emits the `tool-finished` of the call
- **THEN** the `result` holds no `123456`

#### Scenario: A sequence and a token count pass unchanged

- **GIVEN** a shown result `{ "sequence": "ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT", "max_tokens": 100 }`
- **WHEN** the loop emits its `tool-finished`
- **THEN** the `result` holds the whole sequence and `"max_tokens":100`

### Requirement: The root tools of the chat agents declare their views

These tools MUST declare these views. Each is a root tool of the conversation agent or of the report-session agent, except `scan_inputs`, a sandbox tool that the user put in the set:

- `run_script`: the view of "run_script shows its code, its output, and its value" in `script-tools`
- `write_file`, `edit_file`, `update_working_memory`, `workspace_search`, `list_files`, `file_stat`, `scan_inputs`, `inspect_run`, `inspect_data_profile`, `inspect_capability_data`, `list_available_refs`, `list_available_packages`, `examine_page`, and `list_pinned_artifacts`: the input, the result, and the error
- `read_file`, `grep`, `read_tool_output`, `generate_plan`, and `execute_analysis`: the input and the error. The result of each holds workspace bytes or shows in its own card, thus it does not show
- `show_user`, `show_plan`, `show_file`, `start_report_session`, `generate_analogy_report`, `preview_report`, and `record_report_version`: `"none"`

Each other tool of the harness MUST declare `"none"`.

#### Scenario: A read shows its input and not the file

- **GIVEN** a `read_file` call of a root agent that reads a file
- **WHEN** the loop emits the `tool-finished` of the call
- **THEN** the event carries the `input` with the path, and no `result`

#### Scenario: A write shows its input and its result

- **GIVEN** a `write_file` call of a root agent that succeeds
- **WHEN** the loop emits the `tool-finished` of the call
- **THEN** the event carries the `input` with the path and the content, and the `result`

## MODIFIED Requirements

### Requirement: A tool call carries its input, its result, and its error

The contracts MUST export the type `ToolCallValue`, as "A value has a kind" describes. `ToolStartedEvent` MUST have the optional field `input`. `ToolFinishedEvent` and `ToolCallPart` MUST have the optional fields `input`, `result`, and `error`. Each field is a `ToolCallValue`. The fields `toolName`, `outcome`, `detail`, and `durationMs` MUST NOT change, thus a client that does not read the new fields works as before.

For a root call, the loop MUST fill the fields from the view of the tool as follows:

- The `tool-started` of each call gives `input` when the view declares `input`.
- The `tool-finished` of a call with the outcome `ok` gives `input` and `result` when the view declares each.
- The `tool-finished` of a call with the outcome `error` gives `input` when the view declares it, and `error` when the view declares `error`. The shown error is the error message that the model reads, before the loop cuts that text for the model.
- A call that the call policy refused has the outcome `error`. Its `error` is the text of the refusal, for each tool. The call policy writes that text, and it holds no data of the tool. Its `input` obeys the view.
- The `tool-finished` of a call that the user denied gives `input` only, when the view declares it. A denial is a decision of the person, not an error.

The values ride on the events of the tool adapter and of the call policy.

#### Scenario: A successful call carries its input and its result

- **GIVEN** a tool whose view declares `input` and `result`, that gets `{ "path": "data/a.csv" }` and gives `{ "rows": 3 }`
- **WHEN** the loop runs the call
- **THEN** the `tool-started` event gives the `json` input `{"path":"data/a.csv"}` with `cut` false
- **AND** the `tool-finished` event gives the same `input` and the `json` result `{"rows":3}` with `cut` false, and no `error`

#### Scenario: A failed call carries its error

- **GIVEN** a tool whose view declares `input` and `error`, whose call fails with the text `file not found: data/b.csv`
- **WHEN** the loop runs the call
- **THEN** the `tool-finished` event gives the `input` and no `result`
- **AND** the `error` is a `text` value that holds `file not found: data/b.csv`

#### Scenario: A refused call carries the refusal

- **GIVEN** a call of a tool with `view: "none"`, which the call policy refuses
- **WHEN** the loop emits its events
- **THEN** the `tool-finished` event has the outcome `error`, its `error` is the text of the refusal, and it has no `input`

#### Scenario: A denied call carries its input only

- **GIVEN** a call of a tool whose view declares `input` and `error`, which the user denies
- **WHEN** the loop emits its events
- **THEN** the `tool-finished` event has the outcome `denied`, its `input`, and no `result` and no `error`

### Requirement: The emit site makes each value one time, with a cap and a mark

The loop MUST make each value at the emit site, one time for each event, and never at a host. It runs the member of the view, then the steps below on each leaf value. A `json` leaf gets the field-name rule of "The emit site removes the listed secret forms from a value" first. Then each string of the JSON value gets steps 1 and 2 before the serialization, thus no rule meets a JSON escape. A `text` leaf and a `code` leaf get steps 1 and 2 directly. Step 3 runs on the shown text of each leaf. The loop MUST obey the steps in this order:

1. Remove each control character except the tab, the line feed, and the carriage return.
2. Remove each secret form that the text rules of "The emit site removes the listed secret forms from a value" match.
3. Cut a text that is longer than 8,192 UTF-16 code units.

A cut text MUST keep its first 3,072 code units and its last 5,120 code units, with one marker line between them. Thus a cut text holds 8,192 code units and the marker line. The marker line states the count of the code units that it does not show. A cut MUST NOT divide a surrogate pair. A cut leaf MUST have `cut` true, and each other leaf MUST have `cut` false. Each field of a `fields` value is a leaf, thus a value holds at most 4 cut texts.

A text longer than 24,576 code units MUST get steps 1 and 2 only on two windows: its first 11,264 and its last 13,312 code units. A JSON value whose JSON text is longer than 24,576 code units MUST get them only on a copy of each end of the value. Each copy holds at least the same window of the JSON text. Thus the cost of steps 1 and 2 does not grow with the size of a value. Each window reaches 8,192 code units past its shown part. As a result, the steps remove a secret at the edge of a shown part when the secret is shorter than 8,192 code units. The marker line of such a text states the length of the original text less the code units that it shows.

The control characters go first, thus a control byte inside a secret cannot stop a pattern. The secret removal comes before the cut, thus a secret cannot pass when the cut divides it. The shown text of a value can thus differ from the text that the model reads.

#### Scenario: A long result is cut and marked

- **GIVEN** a tool whose view gives its result, a string of 50,000 characters
- **WHEN** the loop emits its `tool-finished`
- **THEN** the `result` has `cut` true
- **AND** its text holds the first 3,072 and the last 5,120 characters of the string, with the marker line between them

#### Scenario: A very long value is cut at a bounded cost

- **GIVEN** a tool whose view gives its result, a JSON array whose JSON text has 10,000,000 characters
- **WHEN** the loop emits its `tool-finished`
- **THEN** the `result` holds the first 3,072 and the last 5,120 characters of that JSON text, with the marker line between them
- **AND** steps 1 and 2 read only the two windows of the JSON text

#### Scenario: A short value is not cut

- **GIVEN** a tool input whose JSON text has 200 characters, and a view that gives the input
- **WHEN** the loop emits the `tool-started`
- **THEN** the `input` holds the whole JSON text, and `cut` is false

#### Scenario: Each field is cut alone

- **GIVEN** a view whose `result` gives two text fields of 20,000 characters each
- **WHEN** the loop emits its `tool-finished`
- **THEN** each field of the `result` has `cut` true, and each holds its own first 3,072 and last 5,120 characters

### Requirement: The stored display keeps the values of a call

The display recorder MUST record the `input`, the `result`, and the `error` of a tool call on its tool-call part. The stored display MUST keep the three fields, and the replay MUST give them. A call whose stream gave a value MUST give the same value after a reload, thus the transcript read `GET {T}/messages` of a host gives them.

A stored row that holds none of the three fields MUST still read. Its tool-call part MUST have no `input`, `result`, or `error` key.

The stream of a run MUST NOT carry a value of a call. A step and the synthesis forward each loop event under `data-loop-event` without the `input`, the `result`, and the `error`. The forwarded event of a call holds its type, its source, its call id, its name, and its detail. It also holds its outcome and its duration when the event has them.

#### Scenario: A reload shows the input and the result

- **GIVEN** a turn with one call that got an input and gave a result, of a tool whose view declares both
- **WHEN** the harness stores the turn and the replay reads it
- **THEN** the tool-call part of the replay holds the same `input` and `result` as the live part, with their kinds

#### Scenario: A reload shows the error of a failed call

- **GIVEN** a turn with one call that failed, of a tool whose view declares `error`
- **WHEN** the harness stores the turn and the replay reads it
- **THEN** the tool-call part of the replay holds the outcome `error` and the `error` of the call

#### Scenario: An old row reads

- **GIVEN** a stored tool call with no `input`, no `result`, and no `error`
- **WHEN** the replay reads it
- **THEN** the tool-call part has none of the three keys

#### Scenario: The run stream does not carry the values

- **GIVEN** a step of a run whose agent calls a tool with a view, and a synthesis that calls a lookup tool
- **WHEN** each forwards its loop events to the stream of the run
- **THEN** the forwarded events hold no `input`, `result`, or `error` of the call, and no raw input

## REMOVED Requirements

### Requirement: No secret leaves the server in a value

**Reason**: Name and format rules cannot remove each secret. A probe found forms that pass, for example `--password hunter2`, `DB_PASS`, and a URL password. The requirement promised more than the rules do.

**Migration**: "The emit site removes the listed secret forms from a value" lists the forms that the rules remove. "A tool declares the view of its calls" keeps each other value out unless a tool declares it.
