## MODIFIED Requirements

### Requirement: Every LLM call produces an attributed usage record

For each LLM call that the harness completes, the harness MUST produce an `LlmUsageRecord`. The calls are each call of `runAgent`, each call of a continuation, and the call of the ad hoc router. The record carries these fields:

- `recordKey`: an idempotency key.
- The session attribution at the call site: `agentId`, `callPath`, the scope ids, and `runId` and `stepId` when the session carries a `RunFrame`.
- `requestedModelId` and `servedModelId`, when the response reports them.
- `usage`: the `ChatUsage` of the call.

A field that a provider or a session does not supply MUST be absent. It MUST NOT be zero, and the harness MUST NOT invent it. A sub-agent run MUST produce its own records under its own `agentId` and `callPath`. Thus the ledger of records is complete across the agent tree. A continuation with an accounting agent id MUST produce its records under that id, and under the `callPath` that `forSubAgent` extends with that id.

The harness MUST deliver each record when its call completes. It MUST NOT defer the record to the end of the run. Thus the calls that completed before a later fatal termination are in the ledger already. An aborted reply that reported usage MUST produce a record like each other reply. A call that reported nothing produces no record.

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

#### Scenario: A post-step continuation is recorded under its accounting id

- **GIVEN** a sandbox step whose file-metadata continuation makes a call that reports usage
- **WHEN** the call completes
- **THEN** the record MUST carry the `agentId` `file-metadata-describer`, and the `runId` and the `stepId` of the step

### Requirement: A direct provider call uses the accounting path of the loop

The ad hoc router calls `provider.chat` directly, outside `runAgent`. It MUST grow the token counters of its call in the body that makes the call, as the harness-agent-loop capability describes. The router uses the agent id `adhoc-router`. It MUST then account for its call through the function that the loop uses for each call. That function MUST do these steps:

- Fold the usage of the call into the turn accumulator of the tool context, when the context has one. Thus the root finish of the turn includes the call.
- Deliver the usage record through the notice helper of the host-hooks capability.

The record key MUST put the fixed call name `adhoc-route` in the slot of the step name. The key also carries the `invocationId` of the tool call that makes the direct call. Thus a replay gives the same key again, and the name cannot collide with a loop step name such as `llm-0`.

A direct call that fails reports no usage, thus it produces no record and no counter.

#### Scenario: The router call reaches the turn total

- **GIVEN** a chat turn in which `execute_analysis` routes an ad hoc request, and the router call reports usage
- **WHEN** the root loop of the turn emits `finish`
- **THEN** the turn total MUST include the usage of the router call

#### Scenario: The router key does not collide with a loop step name

- **GIVEN** an ad hoc route under a `RunFrame`, in a turn whose loop also reports usage
- **WHEN** the records are produced
- **THEN** the key of the router record MUST end with `adhoc-route`, and it MUST differ from each key of the loop

#### Scenario: A failed direct call records nothing

- **GIVEN** a router call that fails with a provider error
- **WHEN** the router falls back
- **THEN** the `UsageRecorder` MUST receive no record for that call
