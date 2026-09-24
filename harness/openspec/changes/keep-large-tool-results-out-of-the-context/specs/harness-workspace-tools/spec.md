## MODIFIED Requirements

### Requirement: execute_command result is bounded with a truncation marker

The `execute_command` result MUST bound each of `stdout` and `stderr` at the stream budget `EXEC_STREAM_BYTE_CAP`, 1,048,576 bytes. The budget is the maximum of a kept text of the tool output store (refer to the harness-agent-loop capability). When a stream exceeds the budget, the result MUST carry the truncation flag of that stream and the original total length. The exit code, the duration, the timeout flag, and each synthetic-failure discriminant MUST pass through with no change.

The budget bounds the memory of the host and the size of a kept text. It does not keep the context of the model small. The loop cuts a long result into an excerpt, and it keeps the text for `read_tool_output`.

The description of the tool MUST state the budget of each stream. It MUST also state that a long result comes back as an excerpt with a reference.

#### Scenario: Oversize stdout is truncated with a marker

- **GIVEN** an `ExecResult` whose `stdout` exceeds 1,048,576 bytes
- **WHEN** `execute_command` returns the result
- **THEN** the returned `stdout` holds at most 1,048,576 bytes, and the result carries the stdout truncation flag with the original total length

#### Scenario: A stream under the budget comes back whole

- **GIVEN** an `ExecResult` whose `stdout` has 200 KiB
- **WHEN** `execute_command` returns the result
- **THEN** the returned `stdout` holds the 200 KiB, and the stdout truncation flag is false
- **AND** the loop then cuts the result into an excerpt and keeps its text

#### Scenario: Exit code and synthetic-failure pass through truncation

- **GIVEN** an `ExecResult` that carries a synthetic failure with an oversize stderr
- **WHEN** `execute_command` returns the result
- **THEN** the synthetic-failure discriminant stays, and `exitCode`, `durationMs`, and `timedOut` come back with no change
