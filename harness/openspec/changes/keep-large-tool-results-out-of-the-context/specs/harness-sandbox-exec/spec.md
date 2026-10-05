## ADDED Requirements

### Requirement: The host keeps each exec stream up to the maximum of the tool output store

The submit of each exec MUST carry `stdoutByteCap` and `stderrByteCap`, with the value `EXEC_STREAM_BYTE_CAP`. `runExec` attaches them to each request, and a caller of `exec` gives no budget.

`exec` of the client MUST cut each stream of the result at the same value with `capExecStreams`, inside the `sandbox.exec` step, before the step returns. The cut on receipt stays, because a server that is older than the budget returns each stream whole.

`EXEC_STREAM_BYTE_CAP` MUST be 1,048,576 bytes, the maximum of a kept text of the tool output store (refer to the harness-agent-loop capability). Thus the host gets each stream that the store can keep, and the loop decides what the model sees. An embedder can give a different value with `execStreamByteCap` of the client configuration.

Each caller of the client gets the same bound: the step agent, the data profile, a session derivation, and a value extraction.

#### Scenario: A submit carries the budget

- **GIVEN** an exec request that carries no budget
- **WHEN** `exec` submits it
- **THEN** the body of `POST /exec` carries `stdoutByteCap` and `stderrByteCap` with the value 1,048,576

#### Scenario: A long stream from an older server is cut on receipt

- **GIVEN** a server that ignores the budget and returns a stdout of 2,097,152 bytes
- **WHEN** the `sandbox.exec` step of the client returns
- **THEN** the stdout holds 1,048,576 bytes, `stdoutTruncated` is true, and `stdoutTotalBytes` gives 2,097,152

#### Scenario: A stream under the budget reaches the host whole

- **GIVEN** a command that writes 300 KiB to stdout
- **WHEN** the result reaches the host
- **THEN** the stdout holds the 300 KiB, and `stdoutTruncated` is false
