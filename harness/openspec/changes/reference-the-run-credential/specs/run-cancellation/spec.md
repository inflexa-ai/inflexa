## MODIFIED Requirements

### Requirement: Convergence phases run isolated after the engine cancel

After a successful engine cancel, the canceler MUST converge the ledgers in this order:

1. the read of the run end that the body recorded (see "The canceler repairs the row of a run whose body recorded its end")
2. the conditional terminal write of the run row
3. the settle of the step rows
4. the close of the running charge, with `reason: "canceled"`, only when the terminal write changed the row and the body recorded no run end
5. the out-of-band revoke of the mandate, only on the condition of phase 4, and only when the row carries a mandate id.

Each phase MUST have its own guard, so that one failure does not skip the phases after it. A failed read of the recorded run end is the one exception: the canceler then MUST NOT do the terminal write.

The writer that wins the run row owns the charge close and the mandate revoke. When the terminal write is refused, the body of the run won the row, and the body closes the charge and revokes its authorization. Thus the canceler MUST NOT close the charge or revoke the mandate. When the terminal write fails, the canceler MUST NOT close the charge or revoke the mandate either. The row then stays active, thus a second cancel converges the run.

The settle of the step rows MUST sweep the still-`pending` rows of the run to `skipped`. It MUST also change the still-`running` rows of the run to `canceled`. A row that the running settle changes MUST get `completed_at`, a duration from its `started_at`, and the reason `external_cancel`. Each of the two step writes MUST have its own guard, so that a failure of one does not skip the other. The running settle MUST be conditional on the row status `running`. Thus it never overwrites a terminal status that a child wrote first.

The `converged` flags of the result MUST show what really occurred. `converged.steps` MUST be true only when the two step writes succeed. `converged.mandate` MUST be true for a row with no persisted mandate id, because no mandate needs a revoke. When the terminal write is refused, `converged.charge` and `converged.mandate` MUST be true, because the canceler has no charge and no mandate to converge. When the terminal write fails, `converged.charge` MUST be false, and `converged.mandate` MUST be false for a row with a persisted mandate id. A failed read of the recorded run end MUST give the same flags as a failed terminal write. When the body recorded a run end, `converged.charge` and `converged.mandate` MUST come from the record, as "The canceler repairs the row of a run whose body recorded its end" states.

#### Scenario: Full convergence

- **WHEN** every phase succeeds for a running run carrying a mandate id
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

- **WHEN** the run row carries no `mandate_id`
- **THEN** no revoke is attempted and `converged.mandate` is true

#### Scenario: A failed terminal write closes no charge

- **GIVEN** a running run that carries a mandate id
- **WHEN** the conditional terminal write fails
- **THEN** the canceler does not close the charge and does not revoke the mandate
- **AND** the step rows still settle, `converged.charge` and `converged.mandate` are false, and `cancel` resolves

### Requirement: The canceler repairs the row of a run whose body recorded its end

After a failed status write, the body of the run does the run end, and it records the run end in the durability engine (see the `workflow-failure-lifecycle` capability). The row of the run then stays `running`. After the engine cancel and before its terminal write, the canceler MUST read that record. The read has three results:

- When the record is present, the body owns the run end. The terminal write MUST write the status and the error of the record, and only to a `running` row. The canceler MUST NOT emit an event, close the charge, or revoke the mandate. When the write changes the row, the canceler MUST record the run outcome metric with the status of the record. It MUST NOT record a step outcome metric. `converged.charge` MUST be the result of the charge close in the record, and `converged.mandate` MUST be the result of the revoke in the record. These flags apply when the write changes the row, when it changes nothing, and when it fails. `finalStatus` MUST be the status of the row after the write.
- When the record is absent, the canceler MUST do the terminal write of `canceled`, as "Convergence phases run isolated after the engine cancel" states.
- When the read fails, the canceler MUST NOT do a terminal write. It MUST NOT emit an event, close the charge, or revoke the mandate. The step rows still settle, and `cancel` resolves. The row stays `running`, thus a second cancel converges the run. A record whose value does not have the shape of a recorded run end counts as a failed read.

In each of the three results, `outcome` MUST be `canceled`.

#### Scenario: A recorded run end repairs the row

- **GIVEN** a running run that carries a mandate id, and whose body recorded its run end with the status `completed`, no error, a successful charge close, and a successful revoke
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

- **GIVEN** a running run that carries a mandate id, and a recorded value with no `status`
- **WHEN** `cancel` runs
- **THEN** the run row stays `running`, the canceler emits no event, closes no charge, and revokes no mandate
- **AND** `converged.charge` and `converged.mandate` are false

#### Scenario: A failed read of the recorded run end writes nothing

- **GIVEN** a running run that carries a mandate id
- **WHEN** the read of the recorded run end fails
- **THEN** the run row stays `running`
- **AND** the canceler emits no event, closes no charge, and revokes no mandate
- **AND** the step rows still settle, `converged.charge` and `converged.mandate` are false, and `cancel` resolves
