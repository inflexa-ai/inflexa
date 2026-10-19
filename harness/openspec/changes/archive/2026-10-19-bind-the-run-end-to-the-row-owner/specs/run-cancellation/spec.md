## MODIFIED Requirements

### Requirement: Convergence phases run isolated after the engine cancel

After a successful engine cancel, the canceler MUST converge the ledgers in this order:

1. the conditional terminal write of the run row
2. the settle of the step rows
3. the close of the running charge, with `reason: "canceled"`, only when the terminal write changed the row
4. the out-of-band revoke of the mandate, only when the terminal write changed the row and the row carries a jti.

Each phase MUST have its own guard, so that one failure does not skip the phases after it.

The writer that wins the run row owns the charge close and the mandate revoke. When the terminal write is refused, the body of the run won the row, and the body closes the charge and revokes its authorization. Thus the canceler MUST NOT close the charge or revoke the mandate. When the terminal write fails, the canceler MUST NOT close the charge or revoke the mandate either. The row then stays active, thus a second cancel converges the run.

The settle of the step rows MUST sweep the still-`pending` rows of the run to `skipped`. It MUST also change the still-`running` rows of the run to `canceled`. A row that the running settle changes MUST get `completed_at`, a duration from its `started_at`, and the reason `external_cancel`. Each of the two step writes MUST have its own guard, so that a failure of one does not skip the other. The running settle MUST be conditional on the row status `running`. Thus it never overwrites a terminal status that a child wrote first.

The `converged` flags of the result MUST show what really occurred. `converged.steps` MUST be true only when the two step writes succeed. `converged.mandate` MUST be true for a row with no persisted jti, because no mandate needs a revoke. When the terminal write is refused, `converged.charge` and `converged.mandate` MUST be true, because the canceler has no charge and no mandate to converge. When the terminal write fails, `converged.charge` MUST be false, and `converged.mandate` MUST be false for a row with a persisted jti.

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

