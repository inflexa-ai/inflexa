## MODIFIED Requirements

### Requirement: Execution start logging

The sandbox-server MUST emit a structured JSON log line to stdout when it
spawns a command in the background after it accepts `POST /exec`. The log line
MUST include these fields:

- `level` ("info")
- `time` (RFC3339 UTC)
- `event` ("exec.start")
- `trace_id` (from the `traceparent` header of the `POST /exec`, or an empty string when the header is absent)
- `exec_id`
- `command` (the joined command array, cut to 200 characters with a "..." suffix when it is longer)
- `cwd` (the working directory, when it is set)
- `pid` (the process ID).

#### Scenario: Command start is logged with trace ID and exec_id
- **GIVEN** a `POST /exec` request with header `traceparent: 00-abcdef1234567890abcdef1234567890-1234567890abcdef-01`
- **AND** body `{"command":["Rscript","analysis.R"],"execId":"wf1:4","cwd":"/artifacts"}`
- **WHEN** the background process spawns
- **THEN** stdout holds a JSON line with `event: "exec.start"`, `trace_id: "abcdef1234567890abcdef1234567890"`, `exec_id: "wf1:4"`, `command: "Rscript analysis.R"`, `cwd: "/artifacts"`, and a numeric `pid`

#### Scenario: Command start logged without trace context
- **GIVEN** a `POST /exec` request without a `traceparent` header
- **WHEN** the process spawns
- **THEN** stdout holds a JSON line with `event: "exec.start"`, the matching `exec_id`, and `trace_id: ""`

#### Scenario: Long command is truncated
- **GIVEN** a command whose joined form is longer than 200 characters
- **WHEN** the process spawns
- **THEN** the `command` field of the log line holds 200 characters with "..." after them

### Requirement: Submit-accepted logging

When the sandbox-server accepts `POST /exec` and returns HTTP 202, it MUST emit a
structured JSON log line to stdout with these fields:

- `level` ("info")
- `time` (RFC3339 UTC)
- `event` ("exec.submitted")
- `trace_id` (from the `traceparent` header, or an empty string when the header is absent)
- `exec_id`
- `dedup_hit` (a boolean: `true` when the submit matched an existing exec record and spawned no new command).

#### Scenario: Fresh submit is logged with dedup_hit=false
- **GIVEN** a `POST /exec` request with the body `{"command":["Rscript","analysis.R"],"execId":"wf1:4"}`
- **WHEN** the server accepts the submit and spawns a new background process
- **THEN** stdout holds a JSON line with `event: "exec.submitted"`, `exec_id: "wf1:4"`, and `dedup_hit: false`

#### Scenario: Duplicate submit logged with dedup_hit=true
- **GIVEN** a `POST /exec` request for an `execId` that the server holds a record of
- **WHEN** the server accepts the submit and spawns no new process
- **THEN** stdout holds a JSON line with `event: "exec.submitted"`, the matching `exec_id`, and `dedup_hit: true`

### Requirement: Spawn failure logging

A background command can fail to spawn, for example when the binary is not
found. Then the sandbox-server MUST emit an `exec.start` event, and after it an
`exec.fail` event with `exit_code: 127` and the spawn error in `stderr_tail`. The two log lines
MUST carry the `exec_id` of the failed submit.

#### Scenario: Binary not found

- **GIVEN** a `POST /exec` with `{"command":["nonexistent-binary"],"execId":"x9"}`
- **WHEN** the spawn fails
- **THEN** stdout holds an `exec.start` event (with `exec_id: "x9"`, pid 0 or omitted) and then an `exec.fail` event with `exec_id: "x9"`, `exit_code: 127`, and a `stderr_tail` that holds the spawn error message
- **AND** the record of `x9` is `failed`, and its result carries `exitCode: 127`

## REMOVED Requirements

### Requirement: Callback delivery logging

**Reason**: The sandbox-server sends no callback, thus no callback attempt exists to log.

**Migration**: None. The `exec.submitted`, `exec.start`, `exec.end`, and `exec.fail` lines stay.

### Requirement: Liveness watchdog logs structured shard summaries

**Reason**: The liveness watchdog is removed. The exec probes the liveness of its own machine (see the harness-sandbox-exec spec).

**Migration**: None.
