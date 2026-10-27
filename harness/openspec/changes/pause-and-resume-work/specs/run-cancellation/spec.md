## MODIFIED Requirements

### Requirement: Cancel is idempotent and never clobbers a concurrent completion

A cancel of an already-terminal run SHALL short-circuit to `outcome: "already_terminal"` with the row's status and no engine call. A cancel of a run with a paused step SHALL delete the rows of the pauses of the run (see the work-pause spec). When the run completes concurrently between the active-check and the terminal write, the conditional write SHALL refuse the transition and `finalStatus` SHALL report the run's own terminal status. The body of the run then owns the charge close and the mandate revoke, thus the canceler MUST NOT do them.

#### Scenario: Second cancel short-circuits

- **WHEN** `cancel` runs against a run whose status is `completed`, `partial`, `failed`, or `canceled`
- **THEN** it returns `outcome: "already_terminal"` with that status, converged flags false, and issues no engine cancel and no charge close

#### Scenario: Concurrent completion wins the row

- **WHEN** the run transitions to `completed` between the canceler's read and its terminal write
- **THEN** the write reports no transition, `finalStatus` is `completed`, and the pending-step sweep still runs (it touches only still-`pending` rows)
- **AND** the canceler does not close the charge and does not revoke the mandate
- **AND** `converged.charge` and `converged.mandate` are true

#### Scenario: Unknown run

- **WHEN** `cancel` is called with a `runId` no row exists for
- **THEN** it rejects with `UnknownRunError`
