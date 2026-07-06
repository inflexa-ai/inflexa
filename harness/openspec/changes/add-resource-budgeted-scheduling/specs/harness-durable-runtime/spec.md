# harness-durable-runtime — delta

## MODIFIED Requirements

### Requirement: Step scheduling is dependency-gated and fails fast

`executeAnalysis` SHALL start each step's child workflow when all of its
`depends_on` steps have completed AND the machine resource budget admits it
(see the resource-budgeted-scheduling capability), with no wave barrier. When
the workflow input carries no budget, dependency satisfaction alone SHALL start
the step. A computed topological level MAY be persisted and emitted for UI
layout but SHALL NOT gate execution. Execution SHALL be fail-fast: the first
step failure or declared blocker SHALL cancel in-flight sibling children with
explicit `DBOS.cancelWorkflow` and stop scheduling new steps; budget-held steps
SHALL simply never be started.

#### Scenario: A ready step starts without waiting for an unrelated sibling

- **GIVEN** a step whose single dependency has just completed and a budget with sufficient remaining capacity
- **WHEN** the scheduler recomputes the ready set
- **THEN** that step starts immediately even if an unrelated step is still running

#### Scenario: A ready step is held while the budget is exhausted

- **GIVEN** a step whose dependencies have all completed and in-flight siblings whose declared resources consume the full budget
- **WHEN** the scheduler recomputes the ready set
- **THEN** the step is not started until an in-flight sibling completes and frees capacity

#### Scenario: First failure cancels in-flight siblings

- **GIVEN** several sibling child workflows in flight and a budget-held ready step
- **WHEN** one in-flight sibling fails or reports a blocker
- **THEN** the parent cancels the remaining in-flight children via `DBOS.cancelWorkflow` and schedules no further steps, including the budget-held one

### Requirement: The scheduler replays deterministically

The parent workflow body SHALL reach the same durable operations in the same
order on replay. The "which child finished first" decision SHALL use
`DBOS.waitFirst` (a checkpointed step), NOT `Promise.race` over `getResult`.
Budget admission decisions SHALL derive only from the workflow input (the
snapshotted budget, the plan's declared step resources) and checkpointed
completion state, so every replay admits the same steps in the same order. UI
emits from the workflow body SHALL be awaited in loop order, and any conditional
post-step emit driven by a non-deterministic producer SHALL gate on a value
checkpointed in `DBOS.runStep`.

#### Scenario: The completion order is checkpointed

- **GIVEN** multiple completed child workflows whose `getResult` resolves instantly on replay
- **WHEN** the scheduler selects the next finished child
- **THEN** it uses `DBOS.waitFirst` so the winning workflow id is recorded and replays identically

#### Scenario: Admission decisions replay identically

- **GIVEN** a recovered parent workflow whose original execution held a step for capacity
- **WHEN** the scheduler loop replays from the checkpointed completion sequence
- **THEN** the same admission decisions are recomputed and the same child workflows are dispatched in the same order
