## MODIFIED Requirements

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
