## MODIFIED Requirements

### Requirement: Capability seams isolate core from managed realizations

Core SHALL declare its external capabilities as injected seams and ship trivial
local realizations, so it runs with filesystem/no-op defaults and no
hosted-service dependency. The external seams MUST be these:

- `RunAuthorizer`: the only constructor of a `RunSession`. `authorize` is a gate. `revoke` and `revokeByJti` are
  notices. The OSS realization is `createLocalRunAuthorizer`.
- `ArtifactRegistry`: the post-step record of the artifacts of a step. `register` is a gate, and `sync` is a notice.
  The OSS realization `createNoopArtifactRegistry` registers nothing outside the harness, and it reports zero
  failures. The harness itself writes the local `cortex_artifacts` ledger around the seam. An embedder without an
  external provenance system has nothing to register.
- `RunCharge`: the run-level billing bracket. `open` is a gate, and `close` is a notice. The OSS realization is
  `createNoopRunCharge`.
- `UsageRecorder`: it gets one usage record for each completed LLM call. `record` is a notice. The OSS realization is
  `createNoopUsageRecorder`.

The embedder can also give two optional hooks to the components that use their values:

- `resolveRequestHeaders` is a gate on each model provider. The provider adds the headers that the hook gives to each
  model request, and it does not read them (see the host-hooks spec).
- `resolveSandboxLabels` is a gate on the configuration of the sandbox client. The client calls it at each spawn, on
  the Docker backend and on the K8s backend (see the sandbox-labels spec).

Each hook MUST be a gate or a notice, and its type MUST show its kind (see the host-hooks spec). If an optional hook is
absent, the provider adds no headers, and the sandbox has no host labels. The harness has no `ResolveBilling` seam, and
it exports no `createNoopBillingResolver`. The shared `RunLauncher` seam (single realization `createDbosRunLauncher`)
SHALL be the only way tools start durable runs. Core SHALL NOT branch on which realization is bound.

#### Scenario: An embedder swaps a seam without touching core

- **GIVEN** an embedder that wires a cloud `ArtifactRegistry` at the composition root
- **WHEN** a workflow records artifacts through the seam
- **THEN** core calls the same interface and never inspects which realization is bound

#### Scenario: Tools reach the durability engine only through RunLauncher

- **GIVEN** the `execute_analysis` tool
- **WHEN** it starts a durable run
- **THEN** it calls `RunLauncher.launch` and never imports the DBOS engine directly

#### Scenario: The OSS ArtifactRegistry realization never fails a registration

- **GIVEN** a runtime assembled with `createNoopArtifactRegistry`
- **WHEN** a step registers its artifacts through the seam
- **THEN** `register` gives `ok({ registered: [], failed: [], failedCount: 0 })`, and `sync` gives `ok` with no effect
- **AND** the local default never fails a step

#### Scenario: A runtime without the optional hooks adds no host values

- **GIVEN** a runtime whose providers have no `resolveRequestHeaders` and whose sandbox client has no `resolveSandboxLabels`
- **WHEN** a step sends a model request and spawns a sandbox
- **THEN** the model request carries no host headers, and the sandbox carries only the harness labels

#### Scenario: The harness exports no billing resolver

- **WHEN** an embedder imports the public exports of `@inflexa-ai/harness`
- **THEN** the exports hold no `ResolveBilling` and no `createNoopBillingResolver`

### Requirement: Step scheduling is dependency-gated and failure-isolated

`executeAnalysis` SHALL start each step's child workflow when all of its
`depends_on` steps have completed AND the machine resource budget admits it
(see the resource-budgeted-scheduling capability), with no wave barrier. When
the workflow input carries no budget, dependency satisfaction alone SHALL start
the step. A computed topological level MAY be persisted and emitted for UI
layout but SHALL NOT gate execution.

A step can settle as `failed` or as `blocked`, or its child can throw for a cause that is not a suspension. Such a
settlement MUST NOT cancel the in-flight siblings, and it MUST NOT stop the scheduler. The parent MUST record the step
as failed. It MUST continue to await the in-flight children, and it MUST dispatch each step that becomes
dependency-satisfied.

Only the failed step's transitive dependents are affected — they can never become
dependency-satisfied (a failed step never enters the completed set) and SHALL
never be dispatched. The parent SHALL run a dispatch round after every child
settlement, not only after completions. The run-level `failureReason` SHALL
record the first failure in checkpointed settlement order; per-step errors ride
on the step ledger and the DAG snapshot.

The halt cascade cancels each in-flight child with an explicit `DBOS.cancelWorkflow`, and it stops the scheduler. The
parent MUST start the halt cascade only on these paths:

- A child settles as a suspension, as a result or as a throw. The parent knows this from the typed suspension message
  of the child (see the workflow-suspension spec).
- The `neverFits` plan-validation guard finds a step that can never fit the budget. The resource-budgeted-scheduling
  capability owns the semantics of this guard.
- An external cancel stops the run.

#### Scenario: A ready step starts without waiting for an unrelated sibling

- **GIVEN** a step whose single dependency has just completed and a budget with sufficient remaining capacity
- **WHEN** the scheduler recomputes the ready set
- **THEN** that step starts immediately even if an unrelated step is still running

#### Scenario: A ready step is held while the budget is exhausted

- **GIVEN** a step whose dependencies have all completed and in-flight siblings whose declared resources consume the full budget
- **WHEN** the scheduler recomputes the ready set
- **THEN** the step is not started until an in-flight sibling settles and frees capacity

#### Scenario: A failure dooms only its transitive dependents

- **GIVEN** a plan `A → B → D` and `A → C → E` where B and C run concurrently after A completes
- **WHEN** B settles as `failed` while C is still running
- **THEN** C keeps running, E is dispatched when C completes, and D is never dispatched
- **AND** the run finalises `partial` with per-step errors on the ledger and `failureReason` recording B's failure

#### Scenario: A thrown child is treated exactly like a failed step

- **GIVEN** two independent in-flight steps
- **WHEN** one child workflow throws for a cause that is not a suspension
- **THEN** its step is recorded failed with the thrown error, the sibling is not cancelled, and scheduling continues

#### Scenario: A blocker is treated exactly like a failed step

- **GIVEN** a plan with a blocked step and an independent ready sibling
- **WHEN** the step settles `blocked`
- **THEN** only the blocked step's transitive dependents are never dispatched and the independent sibling still runs

#### Scenario: A suspension still halts the run

- **GIVEN** three in-flight children
- **WHEN** one child settles as a suspension
- **THEN** the parent cancels the other in-flight children with `DBOS.cancelWorkflow`, and it dispatches no more steps

#### Scenario: A suspension that comes as a throw halts the run

- **GIVEN** a child that sent a typed suspension message and then canceled itself
- **WHEN** `getResult` of that child throws `DBOSWorkflowCancelledError`
- **THEN** the parent identifies the settlement as a suspension, and it starts the halt cascade

### Requirement: Unreachable dependents are visible as skipped in the DAG stream

The `DagStepState.status` vocabulary in the `data-dag-state` part SHALL gain a
`"skipped"` value. When a step settles as a failure or as a blocker, and not as a suspension, the parent MUST walk the
plan DAG. The parent MUST mark each transitive dependent of the failed step as `"skipped"` in the emitted snapshot. A
dependent that is already terminal keeps its status. Thus the snapshot shows which steps can never run and which steps
will still run.

The walk consumes only workflow-input plan data and checkpointed settlement state, so it replays
deterministically. The `StepExecutionRow.status` database enum SHALL NOT
change: ledger rows stay `pending` until the terminal sweep flips them to
`skipped` (see the workflow-failure-lifecycle capability) — skipped visibility
during the run is a stream concern only.

#### Scenario: Dependents of a failed step show as skipped immediately

- **GIVEN** a plan `A → B → D` with D pending and B running
- **WHEN** B settles as `failed`
- **THEN** the next `data-dag-state` emission shows D as `"skipped"` while independent steps keep their own statuses

#### Scenario: The ledger is not written at doom-marking time

- **GIVEN** a step marked `"skipped"` in the stream after its upstream dependency failed
- **WHEN** its `cortex_step_executions` row is read while the run is still in flight
- **THEN** the row still reads `pending`; it reaches `skipped` only via the terminal sweep

#### Scenario: A suspension marks no dependent as skipped

- **GIVEN** a plan `A → B → D`, where D has the status `pending` and B has the status `running`
- **WHEN** B settles as a suspension
- **THEN** the next `data-dag-state` emission does not show D as `"skipped"`

## ADDED Requirements

### Requirement: A `Result` survives a DBOS checkpoint

The harness MUST register the neverthrow classes `Ok` and `Err` with `DBOS.registerSerialization` one time, before
DBOS launches. DBOS saves each workflow input, step output, workflow output, and message with SuperJSON. Without this
registration, SuperJSON does not keep the class of an `Ok` or an `Err`. In that case, a replay gives a plain object that
has no methods of a `Result`.

After the registration, a step and a workflow can return a `Result` as a value. An `err` that a step returns is a
value, not a failure of the step. DBOS records the step as a success. A replay returns the same `err`, and it does not
run the step again. The body MUST use that `err`.

#### Scenario: A replay returns the same err of a step

- **GIVEN** a workflow whose step returned `err(e)`, and a host that stopped after the checkpoint of that step
- **WHEN** DBOS recovers the workflow, and the body runs again
- **THEN** the step does not run again, and the body gets an `Err` whose `isErr()` is `true` and whose `error` is `e`

#### Scenario: The output of a workflow keeps the class of its Result

- **GIVEN** a workflow that returns `err({ kind: "suspended", reason: "payment_required" })`
- **WHEN** the caller reads the output with `getResult`
- **THEN** the caller gets an `Err` whose `isErr()` is `true`, not a plain object

#### Scenario: The registration comes before the launch

- **WHEN** DBOS launches
- **THEN** DBOS already has the serialization recipes of `Ok` and `Err`, and the harness registered each recipe one time

### Requirement: The harness throws only at a DBOS boundary or at the tool dispatch

The harness MUST throw an exception only at these places:

- A step or a workflow that must fail.
- A step that DBOS must retry, because DBOS retries a step only on a throw.
- The self-cancel of a suspension.
- A tool `execute` body. The dispatch catch of the loop changes the throw into an error tool result.

`unwrapOrThrow` MUST be the one bridge from a `Result` to a throw. A failure that must fail a step MUST cross the
DBOS boundary as a throw, as the workspace-root-resolution spec also states. Then DBOS records the step as failed.

The harness MUST catch an exception only at a DBOS boundary, an API boundary, a client boundary, or the dispatch
catch of the loop. A DBOS boundary is a workflow body that gets the throw of a failed step or a failed child workflow.
Then the body runs its failure path. An API boundary is an entry point
where a caller outside the harness gets the outcome of a call. A client boundary is a thin wrapper around a call to
code outside the harness, for example the `pg` driver or a third-party SDK. The wrapper changes the throw into an
`err`.

An exception from DBOS, for example `DBOSWorkflowCancelledError`, MUST reach DBOS with no change. The harness MUST NOT
change such an exception into an `err`. A call to a host hook has no `try` and no `catch` around it (see the
host-hooks spec). Thus `executeAnalysis` MUST NOT put a `try` or a `catch` around a hook call.

#### Scenario: A cancel from DBOS reaches DBOS with no change

- **GIVEN** a workflow that an operator cancels while a step body runs
- **WHEN** the next DBOS call of the body throws `DBOSWorkflowCancelledError`
- **THEN** the exception reaches DBOS with no change, and no harness code changes it into an `err`

#### Scenario: A failure that must fail a step crosses as a throw

- **GIVEN** a step body whose workspace root does not resolve
- **WHEN** the step runs
- **THEN** the failure crosses the DBOS boundary as a throw through `unwrapOrThrow`, and DBOS records the step as failed

#### Scenario: A client boundary changes a throw into an err

- **GIVEN** a query that the `pg` driver refuses with an exception
- **WHEN** the wrapper of the query catches the exception
- **THEN** the caller of the wrapper gets an `err`, and it gets no exception
