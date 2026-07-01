## Purpose
Define the structured execution logging contract for the sandbox layer: the Go
sandbox-server's per-command and per-callback log lines (the bulk of the
observability surface — start/end/fail, optional per-line output, submit
acceptance, and outbound callback delivery), and the Cortex-side liveness
watchdog's structured shard summaries. Sandbox-server logs are command-scoped and
emitted to stdout as JSON; the watchdog logs are per-sweep summaries from the
harness process.
## Requirements
### Requirement: Execution start logging

The sandbox-server SHALL emit a structured JSON log line to stdout when a command is spawned in the background after `POST /exec` is accepted. The log line SHALL include: `level` ("info"), `time` (RFC3339 UTC), `event` ("exec.start"), `trace_id` (from `traceparent` header on the originating `POST /exec`, empty string if absent), `exec_id`, `command` (joined command array, truncated to 200 characters with "..." suffix if longer), `cwd` (working directory if set), and `pid` (process ID).

#### Scenario: Command start is logged with trace ID and exec_id
- **GIVEN** a `POST /exec` request with header `traceparent: 00-abcdef1234567890abcdef1234567890-1234567890abcdef-01`
- **AND** body `{"command":["Rscript","analysis.R"],"execId":"wf1:step1:fn1","cwd":"/artifacts"}`
- **WHEN** the background process is spawned successfully
- **THEN** stdout SHALL contain a JSON line with `event: "exec.start"`, `trace_id: "abcdef1234567890abcdef1234567890"`, `exec_id: "wf1:step1:fn1"`, `command: "Rscript analysis.R"`, `cwd: "/artifacts"`, and a numeric `pid`

#### Scenario: Command start logged without trace context
- **GIVEN** a `POST /exec` request without a `traceparent` header
- **WHEN** the process is spawned
- **THEN** stdout SHALL contain a JSON line with `event: "exec.start"`, the matching `exec_id`, and `trace_id: ""`

#### Scenario: Long command is truncated
- **GIVEN** a command whose joined representation exceeds 200 characters
- **WHEN** the process is spawned
- **THEN** the `command` field in the log line SHALL be truncated to 200 characters with "..." appended

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

When a background command fails to spawn (e.g., binary not found), the sandbox-server SHALL emit an `exec.start` event followed by an `exec.fail` event with `exit_code: 127` and the spawn error in `stderr_tail`. Both log lines SHALL carry the `exec_id` of the failed submit.

#### Scenario: Binary not found
- **GIVEN** a `POST /exec` with `{"command":["nonexistent-binary"],"execId":"x9"}`
- **WHEN** the spawn fails
- **THEN** stdout SHALL contain an `exec.start` event (with `exec_id: "x9"`, pid 0 or omitted) followed by an `exec.fail` event with `exec_id: "x9"`, `exit_code: 127`, and `stderr_tail` containing the spawn error message
- **AND** the sandbox-server SHALL POST a completion callback for `exec_id: "x9"` carrying `exitCode: 127`

### Requirement: Submit-accepted logging

When `POST /exec` is accepted (HTTP 202 returned), the sandbox-server SHALL emit a structured JSON log line to stdout with: `level` ("info"), `time` (RFC3339 UTC), `event` ("exec.submitted"), `trace_id` (from `traceparent` header, empty string if absent), `exec_id`, and `dedup_hit` (boolean, `true` if the submit matched an existing in-memory dedup entry rather than spawning a new command).

#### Scenario: Fresh submit is logged with dedup_hit=false
- **GIVEN** a `POST /exec` request with body `{"command":["Rscript","analysis.R"],"execId":"wf1:step1:fn1"}`
- **WHEN** the submit is accepted and a new background process is spawned
- **THEN** stdout SHALL contain a JSON line with `event: "exec.submitted"`, `exec_id: "wf1:step1:fn1"`, and `dedup_hit: false`

#### Scenario: Duplicate submit logged with dedup_hit=true
- **GIVEN** a `POST /exec` request for an `execId` already present in the dedup map
- **WHEN** the submit is accepted (no new process spawned)
- **THEN** stdout SHALL contain a JSON line with `event: "exec.submitted"`, the matching `exec_id`, and `dedup_hit: true`

### Requirement: Callback delivery logging

For every outbound POST to `${CORTEX_BASE_URL}/sandbox/${execId}/event` or `/complete`, the sandbox-server SHALL emit a structured JSON log line on each attempt: `level` ("info" on 2xx, "warn" on retryable failure, "error" on giveup-eligible 4xx), `time` (RFC3339 UTC), `event` (one of `"callback.event.attempt"`, `"callback.event.delivered"`, `"callback.complete.attempt"`, `"callback.complete.delivered"`), `exec_id`, `attempt` (1-indexed), `status_code` (HTTP status if a response was received, omitted on network error), `error` (error message if any), and `duration_ms`.

#### Scenario: Successful event POST is logged
- **GIVEN** an event POST for `execId: "x1"` returns HTTP 200 on attempt 1
- **WHEN** the response is received
- **THEN** stdout SHALL contain a JSON line with `event: "callback.event.delivered"`, `exec_id: "x1"`, `attempt: 1`, and `status_code: 200`

#### Scenario: Retried event POST logs each attempt
- **GIVEN** an event POST returns HTTP 500 on attempt 1, then HTTP 200 on attempt 2
- **WHEN** both responses are received
- **THEN** stdout SHALL contain a `callback.event.attempt` line for attempt 1 with `status_code: 500`
- **AND** stdout SHALL contain a `callback.event.delivered` line for attempt 2 with `status_code: 200`

#### Scenario: Completion POST is logged
- **GIVEN** a completion POST for `execId: "x2"` returns HTTP 200
- **WHEN** the response is received
- **THEN** stdout SHALL contain a JSON line with `event: "callback.complete.delivered"`, `exec_id: "x2"`, `attempt` ≥ 1, and `status_code: 200`

#### Scenario: 4xx response is logged at error level
- **GIVEN** a callback POST returns HTTP 401
- **WHEN** the response is received
- **THEN** stdout SHALL contain a log line with `level: "error"` and `status_code: 401`
- **AND** no further retry attempts SHALL be logged for that callback

### Requirement: Liveness watchdog logs structured shard summaries

The Cortex-side liveness watchdog (`harness/src/sandbox/watchdog.ts`) SHALL emit a
structured summary per shard check via its injected logger. The summary SHALL
carry `activeCount`, `deadCount`, `syntheticSends`, and `liveWorkflowsSkipped`.
When `isAlive` throws for a row, the watchdog SHALL log a warning and skip that
row for the round. There SHALL be no `sandbox.agent.finish`,
`sandbox.tool_failure_escalated`, or `sandbox.liveness_abort` events and no
`cortex.*` metrics — the real recovery action a dead sandbox triggers is a
`synthetic-failure` done-marker delivered to the recv loop (counted by
`syntheticSends`), not an ndjson-reader abort.

#### Scenario: Shard check logs its summary counts
- **GIVEN** a watchdog shard containing one dead sandbox whose workflow is in-flight
- **WHEN** the shard check completes
- **THEN** an info log SHALL be emitted with `activeCount`, `deadCount`, `syntheticSends`, and `liveWorkflowsSkipped`
- **AND** `syntheticSends` SHALL reflect the synthetic-failure marker sent for the dead sandbox

#### Scenario: isAlive throw is logged and skipped
- **GIVEN** a watchdog shard row whose `isAlive` call throws
- **WHEN** the shard check processes that row
- **THEN** a warning SHALL be logged for the row
- **AND** the row SHALL be skipped for that round rather than treated as dead
