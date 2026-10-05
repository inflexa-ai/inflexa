# run-state-persistence Delta

## ADDED Requirements

### Requirement: Conditional cancel transition guards concurrent completion

`markRunCanceledIfActive(pool, runId, reason)` SHALL transition the run row to `canceled` — stamping `completed_at` and recording `reason` in `error` — only when its status is in the active set (`running`, `suspended_insufficient_funds`), and SHALL report whether a row transitioned. A terminal row SHALL be left untouched.

#### Scenario: Active run transitions

- **WHEN** `markRunCanceledIfActive` runs against a `running` (or `suspended_insufficient_funds`) run
- **THEN** the row becomes `canceled` with `completed_at` and `error = reason` stamped, and the call reports a transition

#### Scenario: Terminal run refused

- **WHEN** `markRunCanceledIfActive` runs against a `completed` run
- **THEN** the row keeps its status, `completed_at`, and `error`, and the call reports no transition
