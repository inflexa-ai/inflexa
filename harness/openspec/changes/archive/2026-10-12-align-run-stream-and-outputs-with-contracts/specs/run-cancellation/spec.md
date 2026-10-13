## MODIFIED Requirements

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
