## MODIFIED Requirements

### Requirement: collectAndComplete is the single finalisation hook

Within the `executeAnalysis` body, `collectAndComplete` MUST be the only block
that writes the terminal run-level state. Two writers act outside a workflow
body: the authorization refusal of `execute_analysis`, where no workflow starts
(see "The run row exists before the workflow body runs"), and the run canceler
after an engine cancel of the parent (see the `run-cancellation` capability).
An engine cancel of the parent stops its body, thus `collectAndComplete` does
not run on that path. `collectAndComplete` MUST run on each terminal path of
the body:

- success
- a run with step failures, which drains the scheduler loop and usually ends `partial`
- the budget halt
- a canceled step, while the parent itself continues
- synthesis failure
- a refused charge open (see "The run opens its charge through a gate before a step starts")
- a suspension (see "An insufficient-budget pause is suspended and made resumable")

Within it, the status write, the charge close, and the run-authorization revoke
MUST each run inside a named `DBOS.runStep`. When the status write changes the
row, the charge close and the revoke MUST run inside the same step as the write,
`persist-final-status`. When the status write is refused or fails, the charge
close and the revoke MUST each run in their own named step,
`close-running-charge` and `revoke-run-auth`. The requirement "The body owns the
end of the run only when its status write wins" gives the reason. The body MUST
log a failure of one of these acts, and it MUST NOT roll back the side effects
that did succeed. There SHALL be NO separate `onError`-style hook racing it; child
step bodies SHALL NOT call `updateRunStatus` or any run-fail helper directly.

`RunCharge.close` and `RunAuthorizer.revoke` are notices (see the `host-hooks`
capability). If a notice gives an `err`, `collectAndComplete` MUST log the reason
at the error level. The terminal status of the run MUST NOT change, and the other
steps of `collectAndComplete` MUST still run.

`collectAndComplete` MUST close the running charge with the outcome that matches
the terminal status:

- `{ kind: "ok" }` for `"completed"` and `"partial"`
- `{ kind: "error" }` for `"failed"`
- `{ kind: "canceled" }` for `"canceled"`
- `{ kind: "suspended", reason }` for `"suspended_insufficient_funds"`, with the reason of the host

On its genuinely-terminal paths (success, runs with step failures, a canceled
step, synthesis failure) `collectAndComplete` SHALL additionally sweep the
run's still-`pending` step rows to `skipped` (stamping `completed_at`) in its
own named `DBOS.runStep`, so a finished run never advertises steps that read as
still waiting to start — including dependents that were never dispatched
because an upstream step failed or blocked. The sweep MUST NOT run on the
resumable suspension branch, because the resumed workflow uses those `pending`
rows. `collectAndComplete` MUST select that branch from the suspension itself,
not from the written run status. A forced failure after a suspension writes
`"failed"`, and it takes the sweep. A sweep-step failure SHALL be logged
without rolling back the other finalisation side effects, matching the hook's
non-rolling-back rule.

#### Scenario: Step bodies do not write run status

- **WHEN** a child workflow body encounters an error
- **THEN** the body lets the error propagate (it does not write `cortex_runs.status`)
- **AND** the parent's `collectAndComplete` owns the run-status transition

#### Scenario: A partial finalisation failure is non-rolling-back

- **WHEN** the charge close succeeds but `RunAuthorizer.revoke` gives an `err`
- **THEN** the revoke failure is logged with the `runId` and reason
- **AND** the already-closed charge and already-written status are not rolled back

#### Scenario: A charge close failure does not change the run status

- **WHEN** `RunCharge.close` gives an `err` on a terminal path
- **THEN** `collectAndComplete` logs the reason of the `err` at the error level
- **AND** the written run status does not change, and `collectAndComplete` still revokes the run authorization

#### Scenario: Unreachable dependents are swept to skipped

- **GIVEN** a plan `A → B → D` and `A → C → E` where B failed, D was therefore never dispatched, and C and E completed
- **WHEN** `collectAndComplete` runs after the scheduler loop drains
- **THEN** D's seeded `pending` row reaches `status="skipped"` with `completed_at` stamped and the run finalises `partial`

#### Scenario: A suspension preserves pending rows

- **GIVEN** a suspended run with unstarted steps seeded `pending`
- **WHEN** `collectAndComplete` runs on the suspension branch
- **THEN** the `pending` rows are left untouched for the resumed workflow to execute


## ADDED Requirements

### Requirement: The body owns the end of the run only when its status write wins

The run body and the run canceler race at the end of a run, and the first
terminal write of the run row wins. The writer that wins the row owns each act
of the run end: the `run_completed` emit, the charge close, and the
run-authorization revoke. The body MUST do these acts only as the owner of the
row.

The body MUST NOT emit `run_completed` before its status write. When the write
of `persist-final-status` changes the row, the same step MUST do these acts, in
this order:

1. It emits `run_completed` with the status of the body. The emit MUST occur
   before another reader can see the terminal status of the row.
2. It records the outcome metrics.
3. It closes the running charge with the outcome of the status.
4. It revokes the run authorization.

These acts come before `persist-synthesis-outcome`, `sweep-pending-steps`, and
`suspend-analysis`. The step list of the suspension branch in "An
insufficient-budget pause is suspended and made resumable" gives no order.

The emit order lets a host that exits when its poll sees a terminal row flush
the run end first. An engine cancel cannot stop a step that started, thus a
cancel cannot cut the body between its won write and these acts.

When a recovery replays the body and gives the won step from the cache, the
body MUST emit `run_completed` again, outside the step. The event MUST carry the
same status, `atMs`, and `durationMs`. The body MUST NOT close the charge or
revoke the authorization again.

When the status write is refused or fails, the body MUST close the charge in
the `close-running-charge` step, and then revoke the authorization in the
`revoke-run-auth` step. Then it MUST emit `run_completed`. A refused write has
two causes:

- The run canceler won the row. The canceler cancels the engine before its
  write, thus the `close-running-charge` step throws the engine cancel. The
  body then stops, and it does no act of the run end.
- A recovery runs the status step again after its own write landed and before
  the step was recorded. The body owns the row, thus it completes the run end.

#### Scenario: A won status write emits one run end before the row shows it

- **WHEN** the status write of `persist-final-status` changes a `running` row to `completed`
- **THEN** the run emit receives one `run_completed` event with the status `completed`
- **AND** the emit occurs before another reader can see the status `completed` on the row
- **AND** the same step closes the charge with `{ kind: "ok" }` and revokes the run authorization with `workflow-completed`

#### Scenario: An engine cancel does not cut the acts of a won write

- **GIVEN** a `persist-final-status` step whose write changed the row to `completed`
- **WHEN** an engine cancel of the parent lands before the step ends
- **THEN** the step still closes the charge with `{ kind: "ok" }` and revokes the run authorization

#### Scenario: A write that the canceler refused leaves the run end to the canceler

- **GIVEN** the run canceler canceled the engine and changed the row to `canceled`
- **WHEN** the status write of the body changes nothing
- **THEN** the body emits no `run_completed` event
- **AND** the `close-running-charge` step throws the engine cancel, thus the body closes no charge and revokes no authorization

#### Scenario: A recovery after the own write landed completes the run end

- **GIVEN** a `persist-final-status` step whose write landed before a crash, and whose result DBOS did not record
- **WHEN** the recovery runs the step again and the write changes nothing
- **THEN** the body closes the charge in `close-running-charge` and revokes the authorization in `revoke-run-auth`
- **AND** the body emits `run_completed` with the `atMs` of the terminal clock read of the first execution

#### Scenario: A replay of a won step emits the run end again

- **WHEN** a recovery replays the body and DBOS gives the won `persist-final-status` step from the cache
- **THEN** the body emits `run_completed` again with the same status, `atMs`, and `durationMs`
- **AND** the body does not close the charge or revoke the authorization again

#### Scenario: A failed status write still closes the charge

- **WHEN** the status write of `persist-final-status` fails
- **THEN** the step logs the failure with the `runId` and the status
- **AND** the body closes the charge in `close-running-charge`, revokes the authorization in `revoke-run-auth`, and then emits `run_completed`
