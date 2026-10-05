## Purpose
Define the structured execution logging contract of the Go sandbox-server. The
contract covers the log lines of each command: the start, the end, the fail,
the optional output of each line, and the submit acceptance. sandbox-server
writes each line to stdout as JSON, and each line is scoped to one command.

## Requirements

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

### Requirement: Execution end logging on success

The sandbox-server SHALL emit a structured JSON log line to stdout when a background-spawned command exits with code 0. The log line SHALL include: `level` ("info"), `time` (RFC3339 UTC), `event` ("exec.end"), `trace_id`, `exec_id`, `pid`, `exit_code` (0), and `duration_ms`.

#### Scenario: Successful command end is logged
- **GIVEN** a command for `exec_id: "x1"` completes with exit code 0 in 4200ms
- **WHEN** the process exits
- **THEN** stdout SHALL contain a JSON line with `event: "exec.end"`, `exec_id: "x1"`, `exit_code: 0`, `duration_ms: 4200`, and the matching `trace_id` and `pid`

### Requirement: Execution fail logging on non-zero exit

The sandbox-server SHALL emit a structured JSON log line to stdout when a background-spawned command exits with a non-zero exit code. The log line SHALL include: `level` ("warn"), `time` (RFC3339 UTC), `event` ("exec.fail"), `trace_id`, `exec_id`, `pid`, `exit_code`, `duration_ms`, `timed_out` (boolean, present only when true), and `stderr_tail` (last 20 lines of stderr, capped at 2048 bytes).

#### Scenario: Failed command logs stderr tail
- **GIVEN** a command for `exec_id: "x2"` produces 50 lines of stderr and exits with code 1
- **WHEN** the process exits
- **THEN** stdout SHALL contain a JSON line with `event: "exec.fail"`, `exec_id: "x2"`, `exit_code: 1`, and `stderr_tail` containing the last 20 lines of stderr (up to 2048 bytes)

#### Scenario: Timed-out command logged as failure
- **GIVEN** a command with `timeout_seconds: 5` that does not exit within 5 seconds
- **WHEN** the process is killed due to timeout
- **THEN** stdout SHALL contain a JSON line with `event: "exec.fail"`, the matching `exec_id`, `exit_code: 124`, `timed_out: true`, and `duration_ms` approximately 5000

#### Scenario: Stderr tail capped at 2KB
- **GIVEN** a command that produces stderr lines averaging 200 bytes each
- **AND** the last 20 lines total more than 2048 bytes
- **WHEN** the process exits with non-zero code
- **THEN** the `stderr_tail` field SHALL be truncated to 2048 bytes from the end

### Requirement: Debug-level stdout/stderr line logging

When `SANDBOX_LOG_LEVEL` is set to `debug`, the sandbox-server SHALL emit a structured JSON log line to stdout for each line of stdout and stderr produced by an executing background command. The log lines SHALL include: `level` ("debug"), `time` (RFC3339 UTC), `event` ("exec.stdout" or "exec.stderr"), `trace_id`, `exec_id`, `pid`, and `data` (the line content).

When `SANDBOX_LOG_LEVEL` is `info` (default), these per-line log events SHALL NOT be emitted.

#### Scenario: Debug mode logs every stdout line
- **GIVEN** `SANDBOX_LOG_LEVEL=debug`
- **AND** a command for `exec_id: "x1"` produces 3 lines of stdout
- **WHEN** the command executes
- **THEN** sandbox-server stdout SHALL contain 3 JSON lines with `event: "exec.stdout"` (one per line, each carrying `exec_id: "x1"`), plus the `exec.start` and `exec.end`/`exec.fail` events

#### Scenario: Info mode does not log per-line output
- **GIVEN** `SANDBOX_LOG_LEVEL=info` (or unset)
- **AND** a command produces 100 lines of stdout
- **WHEN** the command executes
- **THEN** sandbox-server stdout SHALL contain only the `exec.submitted`, `exec.start`, and `exec.end`/`exec.fail` events (no `exec.stdout` or `exec.stderr` lines)

### Requirement: SANDBOX_LOG_LEVEL environment variable

The sandbox-server SHALL read the `SANDBOX_LOG_LEVEL` environment variable at startup. Valid values SHALL be `info` and `debug`. The default SHALL be `info` when the variable is unset or empty. Invalid values SHALL be treated as `info` with a warning log line.

#### Scenario: Default log level
- **GIVEN** `SANDBOX_LOG_LEVEL` is not set
- **WHEN** sandbox-server starts
- **THEN** the log level SHALL be `info`

#### Scenario: Debug log level
- **GIVEN** `SANDBOX_LOG_LEVEL=debug`
- **WHEN** sandbox-server starts
- **THEN** the log level SHALL be `debug`

#### Scenario: Invalid log level falls back to info
- **GIVEN** `SANDBOX_LOG_LEVEL=verbose`
- **WHEN** sandbox-server starts
- **THEN** the log level SHALL be `info`
- **AND** a warning SHALL be logged about the invalid value

### Requirement: Trace ID extraction from traceparent header

The sandbox-server SHALL extract the trace ID from the W3C `traceparent` HTTP header on `POST /exec` requests. The header format is `{version}-{traceId}-{spanId}-{flags}`. The server SHALL split by `-` and extract the second segment (index 1) as the 32-character hex trace ID. If the header is absent, malformed, or the trace ID segment is not exactly 32 characters, the trace ID SHALL be an empty string.

#### Scenario: Valid traceparent header
- **GIVEN** request header `traceparent: 00-abcdef1234567890abcdef1234567890-1234567890abcdef-01`
- **WHEN** the trace ID is extracted
- **THEN** trace_id SHALL be `abcdef1234567890abcdef1234567890`

#### Scenario: Missing traceparent header
- **GIVEN** no `traceparent` header on the request
- **WHEN** the trace ID is extracted
- **THEN** trace_id SHALL be `""`

#### Scenario: Malformed traceparent header
- **GIVEN** request header `traceparent: invalid-value`
- **WHEN** the trace ID is extracted
- **THEN** trace_id SHALL be `""`

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
