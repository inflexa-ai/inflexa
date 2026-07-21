# harness-durable-runtime — delta

> Replaces the fail-fast cascade with failure isolation: a step failure or
> blocker makes only its transitive dependents unreachable, while independent
> branches keep running. The halt cascade survives solely for the budget paths
> (`budget_exceeded`, `neverFits`) and external cancel. Doomed dependents become
> visible as a new `skipped` tier in the `data-dag-state` part.

## REMOVED Requirements

### Requirement: Step scheduling is dependency-gated and fails fast

**Reason**: The fail-fast cascade cancelled in-flight siblings and stopped scheduling on the first step failure, discarding independent work the plan DAG never declared dependent on the failed step. The dependency tree is the plan's language for conditionality; the scheduler no longer second-guesses it.
**Migration**: Replaced by "Step scheduling is dependency-gated and failure-isolated" below. Budget-driven halts are unchanged and remain specified by the resource-budgeted-scheduling capability.

## ADDED Requirements

### Requirement: Step scheduling is dependency-gated and failure-isolated

`executeAnalysis` SHALL start each step's child workflow when all of its
`depends_on` steps have completed AND the machine resource budget admits it
(see the resource-budgeted-scheduling capability), with no wave barrier. When
the workflow input carries no budget, dependency satisfaction alone SHALL start
the step. A computed topological level MAY be persisted and emitted for UI
layout but SHALL NOT gate execution.

A step settling as `failed`, as `blocked`, or by throwing for any non-budget
cause SHALL NOT cancel in-flight siblings and SHALL NOT stop scheduling: the
parent SHALL record the step as failed, continue awaiting in-flight children,
and keep dispatching every step that becomes dependency-satisfied. Only the
failed step's transitive dependents are affected — they can never become
dependency-satisfied (a failed step never enters the completed set) and SHALL
never be dispatched. The parent SHALL run a dispatch round after every child
settlement, not only after completions. The run-level `failureReason` SHALL
record the first failure in checkpointed settlement order; per-step errors ride
on the step ledger and the DAG snapshot.

The halt cascade (cancel in-flight children via explicit `DBOS.cancelWorkflow`
and stop scheduling) SHALL be reserved for the budget paths — a
`budget_exceeded` settlement (graceful or thrown) and the `neverFits`
plan-validation guard — whose semantics are owned by the
resource-budgeted-scheduling capability, and for external cancel.

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
- **WHEN** one child workflow throws for a non-budget cause
- **THEN** its step is recorded failed with the thrown error, the sibling is not cancelled, and scheduling continues

#### Scenario: A blocker is treated exactly like a failed step

- **GIVEN** a plan with a blocked step and an independent ready sibling
- **WHEN** the step settles `blocked`
- **THEN** only the blocked step's transitive dependents are never dispatched and the independent sibling still runs

#### Scenario: Budget-exceeded still halts the run

- **GIVEN** several in-flight children
- **WHEN** a child settles with `budget_exceeded`
- **THEN** the parent cancels the remaining in-flight children via `DBOS.cancelWorkflow` and schedules no further steps

### Requirement: Unreachable dependents are visible as skipped in the DAG stream

The `DagStepState.status` vocabulary in the `data-dag-state` part SHALL gain a
`"skipped"` value. When a non-budget failure or blocker settles, the parent
SHALL walk the plan DAG and mark every transitive dependent of the failed step
that is not already terminal as `"skipped"` in the emitted snapshot, so doomed
steps are distinguishable from steps that will still run. The walk consumes
only workflow-input plan data and checkpointed settlement state, so it replays
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
