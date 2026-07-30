# llm-usage-accounting Specification

## Purpose
TBD - created by archiving change token-usage-tracking. Update Purpose after archive.
## Requirements
### Requirement: Every LLM call produces an attributed usage record

For every LLM call `runAgent` completes, the harness SHALL produce an `LlmUsageRecord` carrying: an idempotency `recordKey`; the session attribution already in hand at the call site (`agentId`, `callPath`, the scope ids, and `runId`/`stepId` when the session carries a `RunFrame`); the requested and served model ids when reported; and the call's `ChatUsage`. Fields a provider or session does not supply SHALL be absent, never zeroed or invented. Sub-agent runs SHALL produce their own records under their own `agentId`/`callPath` — the record ledger is complete across the agent tree.

Records SHALL be delivered as each call completes, never deferred to run completion, so calls that finished before a later fatal termination are already in the ledger. An aborted reply that reported usage SHALL be recorded like any other; a call that reported nothing produces no record.

#### Scenario: A workflow-step call is fully attributed

- **WHEN** an LLM call completes inside a workflow step running under a `RunSession`
- **THEN** its usage record SHALL carry the `agentId`, `callPath`, scope ids, `runId`, and `stepId` of that session alongside the call's `ChatUsage`

#### Scenario: A sub-agent's calls are recorded under the sub-agent

- **GIVEN** a conversation turn in which a tool runs a sub-agent
- **WHEN** the sub-agent's loop makes LLM calls
- **THEN** each call SHALL produce its own record carrying the sub-agent's `agentId` and extended `callPath`

#### Scenario: Unreported fields stay absent

- **GIVEN** a provider that reports usage without a cache breakdown and no served model id
- **WHEN** the record is produced
- **THEN** the unreported fields SHALL be absent from the record rather than zero or defaulted

#### Scenario: Calls before a fatal termination are recorded

- **GIVEN** a run whose third LLM call fails fatally
- **WHEN** the run terminates
- **THEN** the first two calls' records SHALL already have been delivered

#### Scenario: An aborted call's reported usage is recorded

- **GIVEN** a streamed call the client aborts after the provider reported usage
- **WHEN** the loop processes the aborted reply
- **THEN** a record SHALL be produced carrying the reported usage

### Requirement: The UsageRecorder seam is fire-and-forget with a no-op default

The harness SHALL declare a `UsageRecorder` capability seam (`record(record): void`) and ship a no-op OSS default exported from the package barrel. `record` SHALL NOT throw and the loop SHALL NOT await it — a recorder realization failing or blocking MUST NOT fail or slow a run. The seam SHALL be wired at the composition root (`assembleCoreRuntime`) as an optional dependency defaulting to the no-op, reaching every `runAgent` invocation site (conversation agent, sub-agent tool factories, workflow step bodies) through the existing deps bags.

#### Scenario: An unwired embedder is unaffected

- **WHEN** an embedder assembles the runtime without supplying a recorder
- **THEN** the no-op default is used and runs behave exactly as before

#### Scenario: A recorder must not break the run

- **GIVEN** the `UsageRecorder` contract
- **WHEN** the loop delivers a record
- **THEN** delivery SHALL be fire-and-forget: the loop neither awaits nor try/catches its way around a recorder, because the contract forbids `record` to throw

### Requirement: Usage records are replay-safe via deterministic record keys

When the session carries a `RunFrame`, a record's `recordKey` SHALL compose, in order: the `runId`; the frame's `stepId` when present; the session's provenance call path; the tool-call `invocationId` when the loop runs nested inside a tool dispatch; and the loop's deterministic step name — every component replay-stable, so every replay of the same call yields the identical key and no two distinct calls under one run share one. Step names alone are NOT unique across the loops that share a frame (each loop invocation restarts its names), which is why the call-path and invocation-id components are required, not decorative. Outside a `RunFrame` (the HTTP chat path, where no replay exists) the key SHALL be a freshly minted unique id. Consumers MUST upsert on `recordKey`: the harness guarantees key stability across replays, not at-most-once delivery.

#### Scenario: Two steps of one run yield distinct keys

- **GIVEN** two steps of the same analysis run whose loops each make a first LLM call
- **WHEN** their records are produced
- **THEN** the two records SHALL carry distinct `recordKey`s despite sharing the `runId` and the per-workflow step name

#### Scenario: Sibling loops sharing one frame yield distinct keys

- **GIVEN** two different agent loops running under the same `RunFrame` (e.g. a step's file describer and its summary writer)
- **WHEN** each loop's first LLM call is recorded
- **THEN** the two records SHALL carry distinct `recordKey`s despite identical frame ids and identical loop-local step names

#### Scenario: Parallel invocations of one sub-agent yield distinct keys

- **GIVEN** a loop that dispatches the same sub-agent tool twice in one run
- **WHEN** the two child loops' calls are recorded
- **THEN** their key sets SHALL be disjoint, discriminated by the tool-call invocation id

#### Scenario: A replayed step body does not double-count

- **GIVEN** a workflow body replayed by the durability engine after a crash
- **WHEN** the body re-fires `record` for an LLM call whose durable step was served from cache
- **THEN** the record SHALL carry the same `recordKey` as the original delivery, so an upserting consumer counts the call once

#### Scenario: Chat-path keys are unique per call

- **WHEN** two LLM calls complete in the same chat turn
- **THEN** their records SHALL carry distinct `recordKey`s

### Requirement: The chat finish event carries own and turn usage rollups

Every loop's `FinishEvent` SHALL carry an optional usage rollup — that loop's accumulated `ChatUsage` across its own LLM calls, the forced wrap-up included — source-tagged like every chat event. The root loop of a turn SHALL additionally carry a turn total folding its own calls with every descendant loop's. Each figure SHALL be absent when no covered call reported usage, never zero. An error-terminated turn emits no finish event and therefore no rollup — the record ledger remains the complete account.

#### Scenario: A turn's finish reports what its calls used

- **GIVEN** a chat turn whose LLM calls reported usage
- **WHEN** the loop emits `finish`
- **THEN** the event SHALL carry the summed usage of that loop's calls

#### Scenario: The root finish totals the whole turn

- **GIVEN** a turn in which a tool ran a sub-agent whose calls reported usage
- **WHEN** the root loop emits `finish`
- **THEN** its turn total SHALL include the sub-agent's usage beside the root's own rollup

#### Scenario: An unreporting provider yields no rollup

- **GIVEN** a turn in which no call reported usage
- **WHEN** the loop emits `finish`
- **THEN** the event's usage fields SHALL be absent

### Requirement: The run-event stream carries per-step usage for analysis runs

An analysis-run step SHALL emit a `step-usage` run-event part exactly once when its agent loop completes having reported usage, carrying the step id, the step's usage rollup, and the model identity it ran under. A loop that reported no usage has no rollup to carry and SHALL emit no part — a part with an absent figure would be a claim nobody made. The run-completed part SHALL carry an optional aggregate usage for the run. Per-call granularity is the seam's job — parts carry rollups only. Workflows without analysis step parts (target assessment, ephemeral runs, data profiling) reach the ledger through the recorder seam like every loop and gain no usage parts in this capability. Parts ride the existing single run-event stream; the part's id SHALL be a pure function of the run and step ids, the body-level durable stream write is checkpointed by the durability engine (a replayed body finds the recorded write and does not re-insert), and the part is published non-reconciling like its once-per-step siblings.

#### Scenario: A completed step surfaces its usage live

- **WHEN** a step's sandbox-agent loop completes
- **THEN** a `step-usage` part for that step id SHALL appear on the run's event stream

#### Scenario: Replay does not duplicate the part

- **GIVEN** a step whose body is replayed by the durability engine after its `step-usage` part was written
- **WHEN** a consumer reads the stream
- **THEN** exactly one `step-usage` part SHALL be present for that step id — the checkpointed durable write is not re-inserted, and the stable per-step id keeps even an out-of-band duplicate collapsible by id

