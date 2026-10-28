# Spec Delta

## ADDED Requirements

### Requirement: A non-fatal synthesis skip is logged

Each non-fatal skip path (`skipped_no_summaries`, `skipped_blocker`) MUST emit a `logger.warn` through the injected `Logger`, in the namespace `synthesize-run`. The record MUST carry `runId` and the skip reason as structured fields. A skip is an anomaly for an operator, thus it MUST NOT be silent in the logs. A `produced` outcome MUST NOT emit a skip warn. An identifier and a reason are structured fields, and the message text holds neither.

#### Scenario: A blocker skip warns with the reason

- **WHEN** `synthesizeRun` resolves to `skipped_blocker`
- **THEN** a `warn` record is emitted with `runId` and the blocker reason as fields

#### Scenario: A no-summaries skip warns

- **WHEN** `synthesizeRun` resolves to `skipped_no_summaries`
- **THEN** a `warn` record is emitted with `runId` and a `no-summaries` reason

## REMOVED Requirements

### Requirement: Non-fatal synthesis skips are logged

**Reason**: The requirement asks the blocker warn for the count of the `submit_synthesis` refusals and for the refused issue paths. The code records neither (`harness/src/app/synthesize-run.ts`). A MODIFIED block cannot drop the scenario of that telemetry, thus the requirement returns under a new name.

**Migration**: Refer to "A non-fatal synthesis skip is logged" in this capability. The warn carries `runId` and the reason.

### Requirement: Validation-rejection telemetry is captured and surfaced

**Reason**: No code counts the refusals of `submit_synthesis`, and no code keeps their issue paths. The field `validationAttempts` is in no progress part and in no type of the harness.

**Migration**: None. The `skipped` progress part carries the reason of the skip, and the warn of "A non-fatal synthesis skip is logged" carries the same reason.
