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

1. the conditional terminal write of the run row
2. the settle of the step rows
3. the close of the running charge, with `reason: "canceled"`
4. the out-of-band revoke of the mandate, when the row carries a jti.

Each phase MUST have its own guard, so that one failure does not skip the phases after it.

The settle of the step rows MUST sweep the still-`pending` rows of the run to `skipped`. It MUST also change the still-`running` rows of the run to `canceled`. A row that the running settle changes MUST get `completed_at`, a duration from its `started_at`, and the reason `external_cancel`. Each of the two step writes MUST have its own guard, so that a failure of one does not skip the other. The running settle MUST be conditional on the row status `running`. Thus it never overwrites a terminal status that a child wrote first.

The `converged` flags of the result MUST show what really occurred. `converged.steps` MUST be true only when the two step writes succeed. `converged.mandate` MUST be true for a row with no persisted jti, because no mandate needs a revoke.

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

### Requirement: Cancel is idempotent and never clobbers a concurrent completion

A cancel of an already-terminal run SHALL short-circuit to `outcome: "already_terminal"` with the row's status and no engine call. `suspended_insufficient_funds` is a terminal status. When the run completes concurrently between the active-check and the terminal write, the conditional write SHALL refuse the transition and `finalStatus` SHALL report the run's own terminal status.

#### Scenario: Second cancel short-circuits

- **WHEN** `cancel` runs against a run whose status is `completed`, `partial`, `failed`, `canceled`, or `suspended_insufficient_funds`
- **THEN** it returns `outcome: "already_terminal"` with that status, converged flags false, and issues no engine cancel and no charge close

#### Scenario: Concurrent completion wins the row

- **WHEN** the run transitions to `completed` between the canceler's read and its terminal write
- **THEN** the write reports no transition, `finalStatus` is `completed`, and the pending-step sweep still runs (it touches only still-`pending` rows)

#### Scenario: Unknown run

- **WHEN** `cancel` is called with a `runId` no row exists for
- **THEN** it rejects with `UnknownRunError`
