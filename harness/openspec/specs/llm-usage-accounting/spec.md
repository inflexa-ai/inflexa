# llm-usage-accounting Specification

## Purpose
TBD - created by archiving change token-usage-tracking. Update Purpose after archive.
## Requirements
### Requirement: Every LLM call produces an attributed usage record

For each LLM call that the harness completes, the harness MUST produce an `LlmUsageRecord`. The calls are each call of
`runAgent`, the call of the ad hoc router, and the conversion call of `generate_analogy_report`. The record carries these
fields:

- `recordKey`: an idempotency key.
- The session attribution at the call site: `agentId`, `callPath`, the scope ids, and `runId` and `stepId` when the session carries a `RunFrame`.
- `requestedModelId` and `servedModelId`, when the response reports them.
- `usage`: the `ChatUsage` of the call.

A field that a provider or a session does not supply MUST be absent. It MUST NOT be zero, and the harness MUST NOT invent
it. A sub-agent run MUST produce its own records under its own `agentId` and `callPath`. Thus the ledger of records is
complete across the agent tree.

The harness MUST deliver each record when its call completes. It MUST NOT defer the record to the end of the run. Thus
the calls that completed before a later fatal termination are in the ledger already. An aborted reply that reported
usage MUST produce a record like each other reply. A call that reported nothing produces no record.

#### Scenario: A workflow-step call is fully attributed

- **WHEN** an LLM call completes inside a workflow step that runs under a `RunSession`
- **THEN** its usage record MUST carry the `agentId`, `callPath`, scope ids, `runId`, and `stepId` of that session, and the `ChatUsage` of the call

#### Scenario: A sub-agent's calls are recorded under the sub-agent

- **GIVEN** a conversation turn in which a tool runs a sub-agent
- **WHEN** the loop of the sub-agent makes LLM calls
- **THEN** each call MUST produce its own record, with the `agentId` of the sub-agent and the extended `callPath`

#### Scenario: Unreported fields stay absent

- **GIVEN** a provider that reports usage without a cache breakdown and without a served model id
- **WHEN** the record is produced
- **THEN** the fields that the provider did not report MUST be absent from the record, not zero and not a default

#### Scenario: Calls before a fatal termination are recorded

- **GIVEN** a run whose third LLM call fails fatally
- **WHEN** the run terminates
- **THEN** the records of the first two calls MUST be delivered already

#### Scenario: An aborted call's reported usage is recorded

- **GIVEN** a streamed call that the client aborts after the provider reported usage
- **WHEN** the loop processes the aborted reply
- **THEN** the harness MUST produce a record that carries the reported usage

#### Scenario: The ad hoc router call is recorded

- **GIVEN** an ad hoc `execute_analysis` call whose router call reports usage
- **WHEN** the router call completes
- **THEN** the `UsageRecorder` MUST receive one record with the `agentId` `adhoc-router` and the `ChatUsage` of that call

#### Scenario: The analogy conversion call is recorded

- **GIVEN** a `generate_analogy_report` call whose research output does not parse, and whose conversion call reports usage
- **WHEN** the conversion call completes
- **THEN** the `UsageRecorder` MUST receive one record for it, with the `agentId` `analogical-reasoner`

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

An analysis-run step SHALL emit a `step-usage` run-event part exactly once when its agent loop completes having reported usage, carrying the step id, the step's usage rollup, and the model identity it ran under. A loop that reported no usage has no rollup to carry and SHALL emit no part — a part with an absent figure would be a claim nobody made. The run-completed part SHALL carry an optional aggregate usage for the run. Per-call granularity is the seam's job — parts carry rollups only. Workflows without analysis step parts (ephemeral runs, data profiling) reach the ledger through the recorder seam like every loop and gain no usage parts in this capability. Parts ride the existing single run-event stream; the part's id SHALL be a pure function of the run and step ids, the body-level durable stream write is checkpointed by the durability engine (a replayed body finds the recorded write and does not re-insert), and the part is published non-reconciling like its once-per-step siblings.

#### Scenario: A completed step surfaces its usage live

- **WHEN** a step's sandbox-agent loop completes
- **THEN** a `step-usage` part for that step id SHALL appear on the run's event stream

#### Scenario: Replay does not duplicate the part

- **GIVEN** a step whose body is replayed by the durability engine after its `step-usage` part was written
- **WHEN** a consumer reads the stream
- **THEN** exactly one `step-usage` part SHALL be present for that step id — the checkpointed durable write is not re-inserted, and the stable per-step id keeps even an out-of-band duplicate collapsible by id

### Requirement: A phase that owns a step-execution row runs under that step's session

Every workflow phase that seeds and updates a row in the step-execution ledger SHALL run its agent loops under a `RunSession` whose `RunFrame` carries that row's step id, derived from the run session by the same value derivation sandbox steps use. A phase SHALL NOT run under the bare run session while presenting itself as a step.

Attribution is only as good as the session a phase is handed. `runAgent` faithfully copies whatever `stepId` the session carries, so a phase given the bare run frame produces records that are correct about the run and silent about the step — and silence in this ledger means "no provider reported anything", which is a different and false statement about a phase that reported plenty.

The failure is invisible by construction, which is why it is a requirement rather than a convention. Nothing fails to compile, no test fails, and no record is rejected: the rows simply lose a column, and the only symptom is a step that lists everywhere a run's steps are listed while reporting no consumption. Run-level synthesis failed exactly this way — it owned a step row, listed as a step, and recorded its synthesizer loop and every sub-agent under it against the run alone.

This SHALL hold for the phase's whole agent tree. Sub-agents derive from the phase's session, so stamping the phase covers them; a phase that re-derives from the run session for any of its children reintroduces the gap for exactly those calls.

#### Scenario: The synthesis phase's calls carry its step id

- **GIVEN** a run whose synthesis phase makes LLM calls, including calls by sub-agents it dispatches
- **WHEN** those calls are recorded
- **THEN** every record carries the synthesis step id, not the run alone

#### Scenario: A step that reports nothing is distinguishable from one that was never attributed

- **GIVEN** a run's usage grouped by step
- **WHEN** a phase owning a step row made calls that reported quantities
- **THEN** those quantities appear under that step, so an absent figure means the provider reported nothing rather than that the phase was never stamped

#### Scenario: The step segment reaches the record key

- **GIVEN** a phase running under its own step id
- **WHEN** its record keys are composed
- **THEN** they carry the step segment, so that phase and a plan step of the same run cannot mint one key from one call path

### Requirement: A direct provider call uses the accounting path of the loop

The ad hoc router and the analogy conversion call `provider.chat` directly, outside `runAgent`. Each of them MUST grow
the token counters of its call in the body that makes the call, as the harness-agent-loop capability describes. The
router uses the agent id `adhoc-router`, and the conversion uses `analogical-reasoner`. Each of them MUST then account
for its call through the function that the loop uses for each call. That function MUST do these steps:

- Fold the usage of the call into the turn accumulator of the tool context, when the context has one. Thus the root finish of the turn includes the call.
- Deliver the usage record through the notice helper of the host-hooks capability.

The record key MUST put a fixed call name in the slot of the step name. The router uses `adhoc-route`, and the
conversion uses `analogy-conversion`. The key also carries the `invocationId` of the tool call that makes the direct
call. Thus a replay gives the same key again, and the name cannot collide with a loop step name such as `llm-0`.

A direct call that fails reports no usage, thus it produces no record and no counter.

#### Scenario: The router call reaches the turn total

- **GIVEN** a chat turn in which `execute_analysis` routes an ad hoc request, and the router call reports usage
- **WHEN** the root loop of the turn emits `finish`
- **THEN** the turn total MUST include the usage of the router call

#### Scenario: The conversion key does not collide with the research loop

- **GIVEN** a `generate_analogy_report` call under a `RunFrame`, whose research loop and conversion call both report usage
- **WHEN** the records are produced
- **THEN** the key of the conversion record MUST end with `analogy-conversion`, and it MUST differ from each key of the research loop

#### Scenario: A failed direct call records nothing

- **GIVEN** a router call that fails with a provider error
- **WHEN** the router falls back
- **THEN** the `UsageRecorder` MUST receive no record for that call

