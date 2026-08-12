# run-cancellation Specification

## ADDED Requirements

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

After a successful engine cancel, the canceler SHALL converge in order — conditional run-row terminal write, pending-step sweep, running-charge close (`reason: "canceled"`), out-of-band mandate revoke when the row carries a jti — with each phase guarded so one failure does not skip the rest. The returned `converged` flags SHALL reflect what actually happened; `converged.mandate` SHALL be vacuously true for a row with no persisted jti.

#### Scenario: Full convergence

- **WHEN** every phase succeeds for a running run carrying a mandate jti
- **THEN** the result is `outcome: "canceled"`, `finalStatus: "canceled"`, and `converged` all true

#### Scenario: Charge-close failure does not skip the revoke

- **WHEN** `runCharge.close` throws
- **THEN** the mandate is still revoked, `converged.charge` is false, and `cancel` resolves

#### Scenario: No mandate to revoke

- **WHEN** the run row carries no `mandate_jti`
- **THEN** no revoke is attempted and `converged.mandate` is true

### Requirement: Cancel is idempotent and never clobbers a concurrent completion

A cancel of an already-terminal run SHALL short-circuit to `outcome: "already_terminal"` with the row's status and no engine call. When the run completes concurrently between the active-check and the terminal write, the conditional write SHALL refuse the transition and `finalStatus` SHALL report the run's own terminal status.

#### Scenario: Second cancel short-circuits

- **WHEN** `cancel` runs against a run whose status is `completed`, `partial`, `failed`, or `canceled`
- **THEN** it returns `outcome: "already_terminal"` with that status, converged flags false, and issues no engine cancel and no charge close

#### Scenario: Concurrent completion wins the row

- **WHEN** the run transitions to `completed` between the canceler's read and its terminal write
- **THEN** the write reports no transition, `finalStatus` is `completed`, and the pending-step sweep still runs (it touches only still-`pending` rows)

#### Scenario: Unknown run

- **WHEN** `cancel` is called with a `runId` no row exists for
- **THEN** it rejects with `UnknownRunError`
