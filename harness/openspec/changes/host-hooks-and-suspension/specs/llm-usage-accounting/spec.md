## MODIFIED Requirements

### Requirement: The UsageRecorder seam is fire-and-forget with a no-op default

The harness MUST declare a `UsageRecorder` capability seam. The package barrel MUST export a no-op OSS default. The seam SHALL be wired at the composition root (`assembleCoreRuntime`) as an optional dependency defaulting to the no-op, reaching every `runAgent` invocation site (conversation agent, sub-agent tool factories, workflow step bodies) through the existing deps bags.

`UsageRecorder.record(record)` MUST return `ResultAsync<void, NoticeFailure>`. Thus `record` is a notice, as the
host-hooks capability describes. `record` MUST give a failure as an `err`, not as a throw.

The loop MUST NOT wait for the result, and it MUST NOT put a `try` or a `catch` around the call. When the result
arrives, the loop MUST log the reason of an `err` at the error level. A recorder failure MUST NOT fail a run, and a
recorder that blocks MUST NOT make a run slower.

#### Scenario: An unwired embedder is unaffected

- **WHEN** an embedder assembles the runtime without supplying a recorder
- **THEN** the no-op default is used and runs behave exactly as before

#### Scenario: A recorder must not break the run

- **GIVEN** the `UsageRecorder` contract
- **WHEN** the loop delivers a record
- **THEN** the loop does not wait for the result, and it puts no `try` or `catch` around the call

#### Scenario: A recorder err is logged, and the run continues

- **GIVEN** a recorder whose `record` gives `errAsync({ reason: "r" })`
- **WHEN** the loop delivers a record
- **THEN** the loop logs the reason `r` at the error level when the result arrives
- **AND** the run continues, and its outcome does not change
