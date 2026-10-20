# run-cancellation Specification

## Purpose
The run canceler is the external cancel path of an `executeAnalysis` run. It cancels the parent
workflow and each child workflow. Then it closes what the canceled workflow cannot close: the run
row, the pending step rows, the run charge, and the run mandate. A second cancel changes nothing, and
a cancel never overwrites a completion that occurs at the same time.

## Requirements

### Requirement: The canceler cancels the parent workflow and every child

`createRunCanceler(deps).cancel(runId, session)` SHALL cancel the DBOS parent workflow (whose id equals `runId` by the launch contract) with child-cascading reach, additionally cancel the run's persisted incomplete `child_workflow_id`s, and re-query the step ledger once after the parent cancel to cancel any late-committing child ids. The engine capability SHALL stay internal to the module behind an optional injectable seam whose production default is the `DBOSClient`-backed child-cascading cancel.

#### Scenario: Children reached through both ledgers

- **WHEN** `cancel` runs against an active run with one step row carrying an incomplete `child_workflow_id`
- **THEN** the engine cancel receives the parent workflow id and that child id, with child-cascading enabled

#### Scenario: Late-committing child swept by the re-query

- **WHEN** a child's `child_workflow_id` commits to the step ledger only after the parent cancel was issued
- **THEN** the post-cancel re-query finds it and a second engine cancel covers it

#### Scenario: Engine-cancel failure rejects

- **WHEN** the engine cancel itself fails
- **THEN** `cancel` rejects without converging any ledger, so a host retry finds the run still active

### Requirement: Convergence phases run isolated after the engine cancel

After a successful engine cancel, the canceler MUST converge the ledgers in this order:

1. the read of the run end that the body recorded (see "The canceler repairs the row of a run whose body recorded its end")
2. the conditional terminal write of the run row
3. the settle of the step rows
4. the close of the running charge, with `reason: "canceled"`, only when the terminal write changed the row and the body recorded no run end
5. the out-of-band revoke of the mandate, only on the condition of phase 4, and only when the row carries a jti.

Each phase MUST have its own guard, so that one failure does not skip the phases after it. A failed read of the recorded run end is the one exception: the canceler then MUST NOT do the terminal write.

The writer that wins the run row owns the charge close and the mandate revoke. When the terminal write is refused, the body of the run won the row, and the body closes the charge and revokes its authorization. Thus the canceler MUST NOT close the charge or revoke the mandate. When the terminal write fails, the canceler MUST NOT close the charge or revoke the mandate either. The row then stays active, thus a second cancel converges the run.

The settle of the step rows MUST sweep the still-`pending` rows of the run to `skipped`. It MUST also change the still-`running` rows of the run to `canceled`. A row that the running settle changes MUST get `completed_at`, a duration from its `started_at`, and the reason `external_cancel`. Each of the two step writes MUST have its own guard, so that a failure of one does not skip the other. The running settle MUST be conditional on the row status `running`. Thus it never overwrites a terminal status that a child wrote first.

The `converged` flags of the result MUST show what really occurred. `converged.steps` MUST be true only when the two step writes succeed. `converged.mandate` MUST be true for a row with no persisted jti, because no mandate needs a revoke. When the terminal write is refused, `converged.charge` and `converged.mandate` MUST be true, because the canceler has no charge and no mandate to converge. When the terminal write fails, `converged.charge` MUST be false, and `converged.mandate` MUST be false for a row with a persisted jti. A failed read of the recorded run end MUST give the same flags as a failed terminal write. When the body recorded a run end, `converged.charge` and `converged.mandate` MUST come from the record, as "The canceler repairs the row of a run whose body recorded its end" states.

#### Scenario: Full convergence

- **WHEN** every phase succeeds for a running run carrying a mandate jti
- **THEN** the result is `outcome: "canceled"`, `finalStatus: "canceled"`, and `converged` all true

#### Scenario: A step cut mid-flight settles as canceled

- **GIVEN** an active run with one step row `running` and one step row `pending`
- **WHEN** `cancel` runs and each phase succeeds
- **THEN** the `running` row is `canceled`, with `completed_at` and the reason `external_cancel`
- **AND** the `pending` row is `skipped`, and `converged.steps` is true

#### Scenario: A step that settled first keeps its status

- **WHEN** a child writes its step row `completed` after the engine cancel and before the settle of the step rows
- **THEN** the settle does not change that row

#### Scenario: A failed step write does not skip the other

- **WHEN** the pending sweep fails
- **THEN** the running settle and the later phases still run, `converged.steps` is false, and `cancel` resolves

#### Scenario: Charge-close failure does not skip the revoke

- **WHEN** `runCharge.close` throws
- **THEN** the mandate is still revoked, `converged.charge` is false, and `cancel` resolves

#### Scenario: No mandate to revoke

- **WHEN** the run row carries no `mandate_jti`
- **THEN** no revoke is attempted and `converged.mandate` is true

#### Scenario: A failed terminal write closes no charge

- **GIVEN** a running run that carries a mandate jti
- **WHEN** the conditional terminal write fails
- **THEN** the canceler does not close the charge and does not revoke the mandate
- **AND** the step rows still settle, `converged.charge` and `converged.mandate` are false, and `cancel` resolves

### Requirement: Cancel is idempotent and never clobbers a concurrent completion

A cancel of an already-terminal run SHALL short-circuit to `outcome: "already_terminal"` with the row's status and no engine call. `suspended_insufficient_funds` is a terminal status. When the run completes concurrently between the active-check and the terminal write, the conditional write SHALL refuse the transition and `finalStatus` SHALL report the run's own terminal status. The body of the run then owns the charge close and the mandate revoke, thus the canceler MUST NOT do them.

#### Scenario: Second cancel short-circuits

- **WHEN** `cancel` runs against a run whose status is `completed`, `partial`, `failed`, `canceled`, or `suspended_insufficient_funds`
- **THEN** it returns `outcome: "already_terminal"` with that status, converged flags false, and issues no engine cancel and no charge close

#### Scenario: Concurrent completion wins the row

- **WHEN** the run transitions to `completed` between the canceler's read and its terminal write
- **THEN** the write reports no transition, `finalStatus` is `completed`, and the pending-step sweep still runs (it touches only still-`pending` rows)
- **AND** the canceler does not close the charge and does not revoke the mandate
- **AND** `converged.charge` and `converged.mandate` are true

#### Scenario: Unknown run

- **WHEN** `cancel` is called with a `runId` no row exists for
- **THEN** it rejects with `UnknownRunError`

### Requirement: The canceler records the end of the run that it cancels

The canceler MUST take the optional `ProvenanceSeam` of the harness. That value can bind a run emit. If the conditional terminal write changes the run row to `canceled`, the canceler MUST emit these events through that run emit, in this order:

1. One `step_completed` event with the status `canceled` for each step that the cancel cut. A cut step is a step row with a child workflow id and no `completed_at`, read after the engine cancel.
2. One `run_completed` event with the status `canceled`.

Each event MUST carry the session that the caller gave to `cancel`. The canceler MUST read the wall clock one time, after the terminal write, and each event MUST carry that time as `atMs`. The canceler is not a workflow, thus no replay fires these events again. The conditional write lets only one cancel of a run win, thus only one cancel emits them.

The `durationMs` of `run_completed` MUST be `atMs` minus the `started_at` of the run row, and not less than 0. The `durationMs` of each `step_completed` MUST be `atMs` minus the `started_at` of its step row, and not less than 0. It MUST be absent when the step row has no valid `started_at`.

When the read of the cut steps fails, the canceler MUST emit no `step_completed` event, and it MUST still emit `run_completed`.

A cancel whose terminal write changes no row MUST emit nothing, because the run ended by itself and its body recorded the end. A cancel that finds a run end that the body recorded MUST emit nothing, also when its repair write changes the row to `canceled`. A failed read of the recorded run end MUST emit nothing. A failed terminal write MUST emit nothing. A cancel of an already-terminal run MUST emit nothing. A throw of the run emit MUST go to the log. It MUST NOT skip a later event or a later convergence phase. It MUST NOT change the result of `cancel`. When no run emit is bound, the canceler MUST behave as it did with no `ProvenanceSeam`.

#### Scenario: A won cancel records the cut steps and the run end

- **GIVEN** an active run with one cut step, and a bound run emit
- **WHEN** `cancel` runs and the terminal write changes the run row to `canceled`
- **THEN** the run emit receives `step_completed` with the status `canceled` for the cut step, and then `run_completed` with the status `canceled`
- **AND** each event carries the session of the cancel and the same `atMs`
- **AND** the `durationMs` of each event is `atMs` minus the `started_at` of its row

#### Scenario: A concurrent completion emits nothing

- **WHEN** the run changes to `completed` between the read of the canceler and its terminal write
- **THEN** the run emit receives no event

#### Scenario: A recorded run end emits nothing

- **GIVEN** a running run whose body recorded its run end with the status `canceled`
- **WHEN** `cancel` runs and its repair write changes the row to `canceled`
- **THEN** the run emit receives no event

#### Scenario: A second cancel emits nothing

- **WHEN** `cancel` runs against a run whose status is `canceled`
- **THEN** the run emit receives no event

#### Scenario: A failed read of the cut steps still records the run end

- **WHEN** the read of the cut steps after the engine cancel fails, and the terminal write wins
- **THEN** the run emit receives `run_completed` with the status `canceled`, and no `step_completed` event

#### Scenario: A throwing run emit does not stop the convergence

- **WHEN** the bound run emit throws on each event
- **THEN** the canceler emits each event, logs each throw, settles the step rows, closes the charge, and revokes the mandate
- **AND** `cancel` resolves with the same result that it gives with no `ProvenanceSeam`

#### Scenario: No bound run emit changes nothing

- **WHEN** the canceler has no `ProvenanceSeam`, or one with no run emit
- **THEN** `cancel` converges the ledgers and gives the same result as before, and it emits nothing

### Requirement: The canceler repairs the row of a run whose body recorded its end

After a failed status write, the body of the run does the run end, and it records the run end in the durability engine (see the `workflow-failure-lifecycle` capability). The row of the run then stays `running`. After the engine cancel and before its terminal write, the canceler MUST read that record. The read has three results:

- When the record is present, the body owns the run end. The terminal write MUST write the status and the error of the record, and only to a `running` row. The canceler MUST NOT emit an event, close the charge, or revoke the mandate. When the write changes the row, the canceler MUST record the run outcome metric with the status of the record. It MUST NOT record a step outcome metric. `converged.charge` MUST be the result of the charge close in the record, and `converged.mandate` MUST be the result of the revoke in the record. These flags apply when the write changes the row, when it changes nothing, and when it fails. `finalStatus` MUST be the status of the row after the write.
- When the record is absent, the canceler MUST do the terminal write of `canceled`, as "Convergence phases run isolated after the engine cancel" states.
- When the read fails, the canceler MUST NOT do a terminal write. It MUST NOT emit an event, close the charge, or revoke the mandate. The step rows still settle, and `cancel` resolves. The row stays `running`, thus a second cancel converges the run. A record whose value does not have the shape of a recorded run end counts as a failed read.

In each of the three results, `outcome` MUST be `canceled`.

#### Scenario: A recorded run end repairs the row

- **GIVEN** a running run that carries a mandate jti, and whose body recorded its run end with the status `completed`, no error, a successful charge close, and a successful revoke
- **WHEN** `cancel` runs
- **THEN** the run row holds `completed`, with `completed_at` set and no error
- **AND** the canceler emits no event, closes no charge, and revokes no mandate
- **AND** the result is `outcome: "canceled"`, `finalStatus: "completed"`, and `converged.charge` and `converged.mandate` true

#### Scenario: A recorded run end keeps the error of the body

- **GIVEN** a running run whose body recorded its run end with the status `failed` and an error
- **WHEN** `cancel` runs
- **THEN** the run row holds `failed` with that error

#### Scenario: The flags show a failed charge close of the body

- **GIVEN** a running run whose body recorded its run end with a failed charge close and a successful revoke
- **WHEN** `cancel` runs and the repair write changes the row
- **THEN** `converged.charge` is false and `converged.mandate` is true

#### Scenario: A repair write that changes nothing records no metric

- **GIVEN** a running run whose body recorded its run end with the status `completed`
- **WHEN** the row leaves `running` after the read of the canceler and before its repair write
- **THEN** the repair write changes nothing, the canceler records no run outcome metric, and `finalStatus` is the status of the row

#### Scenario: A record with a wrong shape counts as a failed read

- **GIVEN** a running run that carries a mandate jti, and a recorded value with no `status`
- **WHEN** `cancel` runs
- **THEN** the run row stays `running`, the canceler emits no event, closes no charge, and revokes no mandate
- **AND** `converged.charge` and `converged.mandate` are false

#### Scenario: A failed read of the recorded run end writes nothing

- **GIVEN** a running run that carries a mandate jti
- **WHEN** the read of the recorded run end fails
- **THEN** the run row stays `running`
- **AND** the canceler emits no event, closes no charge, and revokes no mandate
- **AND** the step rows still settle, `converged.charge` and `converged.mandate` are false, and `cancel` resolves
