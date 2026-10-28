## MODIFIED Requirements

### Requirement: The scheduler replays deterministically

The parent workflow body MUST reach the same durable operations in the same
order on replay. The "which child finished first" decision MUST use
`DBOS.waitFirst` (a checkpointed step), NOT `Promise.race` over `getResult`.
Dispatch decisions MUST derive only from the plan in the workflow input and the
checkpointed completion state. Thus every replay dispatches the same steps in the
same order. The body MUST await its UI emits in loop order. A conditional
post-step emit from a non-deterministic producer MUST gate on a value
checkpointed in `DBOS.runStep`.

#### Scenario: The completion order is checkpointed

- **GIVEN** multiple completed child workflows whose `getResult` resolves instantly on replay
- **WHEN** the scheduler selects the next finished child
- **THEN** it uses `DBOS.waitFirst` so the winning workflow id is recorded and replays identically

#### Scenario: Admission decisions replay identically

- **GIVEN** a recovered parent workflow whose original execution dispatched steps as their dependencies completed
- **WHEN** the scheduler loop replays from the checkpointed completion sequence
- **THEN** the same dispatch decisions are recomputed and the same child workflows are dispatched in the same order

## REMOVED Requirements

### Requirement: Step scheduling is dependency-gated and failure-isolated

**Reason**: The scheduler admits no step against a budget, thus the scenario of a held step is no longer true. The requirement returns under a new name.

**Migration**: Refer to "Step scheduling is dependency-gated, failure-isolated, and free of a budget".

## ADDED Requirements

### Requirement: Step scheduling is dependency-gated, failure-isolated, and free of a budget

`executeAnalysis` MUST start each step's child workflow when all of its
`depends_on` steps have completed, with no wave barrier. The scheduler admits
no step against a resource budget. The step agent acquires its sandbox, and the
sandbox-leases capability admits each lease against the budget. A computed
topological level can be persisted and emitted for UI layout, but it MUST NOT
gate execution.

A step can settle as `failed` or as `blocked`, or its child can throw for a cause that is not a suspension. Such a
settlement MUST NOT cancel the in-flight siblings, and it MUST NOT stop the scheduler. The parent MUST record the step
as failed. It MUST continue to await the in-flight children, and it MUST dispatch each step that becomes
dependency-satisfied.

Only the failed step's transitive dependents are affected — they can never become
dependency-satisfied (a failed step never enters the completed set) and MUST
never be dispatched. The parent MUST run a dispatch round after every child
settlement, not only after completions. The run-level `failureReason` MUST
record the first failure in checkpointed settlement order. The per-step errors ride
on the step ledger and the DAG snapshot.

The halt cascade cancels each in-flight child with an explicit `DBOS.cancelWorkflow`, and it stops the scheduler. The
parent MUST start the halt cascade only on these paths:

- A child settles as a suspension, as a result or as a throw. The parent knows this from the typed suspension message
  of the child (see the workflow-suspension spec).
- An external cancel stops the run.

#### Scenario: A ready step starts without waiting for an unrelated sibling

- **GIVEN** a step whose single dependency has just completed
- **WHEN** the scheduler recomputes the ready set
- **THEN** that step starts immediately even if an unrelated step is still running

#### Scenario: A ready step starts while the leases hold the budget

- **GIVEN** a budget of `{ cpu: 4, memoryGb: 8 }`, and two in-flight steps whose leases hold the full budget
- **WHEN** a third step becomes dependency-satisfied
- **THEN** the scheduler starts the third step at once
- **AND** the `acquire_sandbox` call of the step waits for a grant until a lease frees capacity

#### Scenario: A failure dooms only its transitive dependents

- **GIVEN** a plan `A → B → D` and `A → C → E` where B and C run concurrently after A completes
- **WHEN** B settles as `failed` while C is still running
- **THEN** C keeps running, E is dispatched when C completes, and D is never dispatched
- **AND** the run finalizes `partial` with per-step errors on the ledger and `failureReason` recording B's failure

#### Scenario: A thrown child is treated exactly like a failed step

- **GIVEN** two independent in-flight steps
- **WHEN** one child workflow throws for a cause that is not a suspension
- **THEN** its step is recorded failed with the thrown error, the sibling is not canceled, and scheduling continues

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
