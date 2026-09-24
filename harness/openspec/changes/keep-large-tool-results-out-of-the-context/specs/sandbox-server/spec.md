## MODIFIED Requirements

### Requirement: Completion callback

The sandbox-server MUST produce a JSON completion payload
`{ execId, exitCode, stdout, stderr, stdoutTruncated?, stderrTruncated?, stdoutTotalBytes?, stderrTotalBytes?, durationMs, provenance?, timedOut?, usage? }`
when a spawned command exits: a success, a failure, a kill, or a timeout. In
**callback mode** it MUST POST this payload to
`${CORTEX_BASE_URL}/sandbox/${execId}/complete` at most one time for each
`execId`, for each exit code. In **poll mode** it MUST keep the payload as the
terminal `result` of the exec, and the exec-result endpoint serves it (signed).
In poll mode the server MUST POST nothing. In both modes the server MUST produce
the payload for a zero exit code and for a non-zero exit code.

Each stream of the payload MUST hold at most the byte budget of the submit,
`stdoutByteCap` or `stderrByteCap`. Past the budget, the server MUST count the
bytes and drop them, and it keeps the start of the stream. The payload MUST then
carry the truncation flag of that stream and the total bytes of the stream. A
budget of 0, or no budget, keeps the whole stream. The server MUST NOT end a kept
stream with a part of a UTF-8 sequence.

#### Scenario: Successful exit yields completion
- **GIVEN** a command spawned for `execId: "x1"` exits with code 0
- **WHEN** sandbox-server reaps the process
- **THEN** the completion payload MUST contain `exitCode: 0`, the `stdout`, the `stderr`, and `durationMs`. The server POSTs it to `/complete` in callback mode, and it keeps it as the served terminal result in poll mode.
- **AND** the dedup map entry for `x1` MUST move to `completed`

#### Scenario: Non-zero exit yields completion
- **GIVEN** a command spawned for `execId: "x2"` exits with code 1
- **WHEN** sandbox-server reaps the process
- **THEN** the completion payload MUST contain `exitCode: 1` and the stderr payload

#### Scenario: Callback-mode completion posted exactly once per execId
- **GIVEN** callback mode, and a command spawned for `execId: "x3"` that exited
- **WHEN** the completion POST succeeds with an HTTP 2xx response from Cortex
- **THEN** the sandbox-server MUST NOT POST `/complete` again for `execId: "x3"`

#### Scenario: A stream past the budget keeps its start
- **GIVEN** a submit with `stdoutByteCap` 1,048,576, and a command that writes 3,145,728 bytes to stdout
- **WHEN** the command exits
- **THEN** the payload `stdout` holds the first 1,048,576 bytes, `stdoutTruncated` is true, and `stdoutTotalBytes` is 3,145,728
