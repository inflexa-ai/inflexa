# workflow-failure-lifecycle — delta

> The finalisation hook's path enumeration loses its "fail-fast" path: runs with
> step failures now drain the scheduler loop and finalise like any other
> genuinely-terminal run (typically `partial`). The pending→`skipped` sweep is
> unchanged in mechanism but now covers steps that were unreachable because an
> upstream dependency failed.

## MODIFIED Requirements

### Requirement: collectAndComplete is the single finalisation hook

`collectAndComplete` SHALL be the only block that finalises run-level state, and
it SHALL run on every terminal path: success, runs with step failures (which
drain the scheduler loop and typically finalise `partial`), the budget halt,
external cancel, synthesis failure, and the 402 pause. Within it the status
write, charge close, and run-authorization revoke SHALL each be their own named
`DBOS.runStep`, and a failure of any one SHALL be logged without rolling back
the side effects that did succeed. There SHALL be NO separate `onError`-style
hook racing it; child step bodies SHALL NOT call `updateRunStatus` or any
run-fail helper directly.

On its genuinely-terminal paths (success, runs with step failures, external
cancel, synthesis failure) `collectAndComplete` SHALL additionally sweep the
run's still-`pending` step rows to `skipped` (stamping `completed_at`) in its
own named `DBOS.runStep`, so a finished run never advertises steps that read as
still waiting to start — including dependents that were never dispatched
because an upstream step failed or blocked. The sweep SHALL NOT run on the
resumable 402 budget-pause branch — the branch is selected structurally (the
pause path itself), never inferred from the written run status (the pause also
writes `"canceled"`) — because the resumed workflow still needs those `pending`
rows. A sweep-step failure SHALL be logged without rolling back the other
finalisation side effects, matching the hook's non-rolling-back rule.

#### Scenario: Step bodies do not write run status

- **WHEN** a child workflow body encounters an error
- **THEN** the body lets the error propagate (it does not write `cortex_runs.status`)
- **AND** the parent's `collectAndComplete` owns the run-status transition

#### Scenario: A partial finalisation failure is non-rolling-back

- **WHEN** the charge close succeeds but the run-authorization revoke step throws
- **THEN** the revoke failure is logged with the `runId` and reason
- **AND** the already-closed charge and already-written status are not rolled back

#### Scenario: Unreachable dependents are swept to skipped

- **GIVEN** a plan `A → B → D` and `A → C → E` where B failed, D was therefore never dispatched, and C and E completed
- **WHEN** `collectAndComplete` runs after the scheduler loop drains
- **THEN** D's seeded `pending` row reaches `status="skipped"` with `completed_at` stamped and the run finalises `partial`

#### Scenario: The budget pause preserves pending rows

- **GIVEN** a run paused on the 402 budget path with unstarted steps seeded `pending`
- **WHEN** `collectAndComplete` runs on the pause branch
- **THEN** the `pending` rows are left untouched for the resumed workflow to execute
