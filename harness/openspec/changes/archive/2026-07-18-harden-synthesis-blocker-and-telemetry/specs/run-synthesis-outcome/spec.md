## ADDED Requirements

### Requirement: Validation-rejection telemetry is captured and surfaced

`generateRunSynthesis` SHALL count how many `submit_synthesis` calls were
rejected by validation during its loop and SHALL capture the rejected validation
issue paths. It SHALL carry the rejection count (and, for a skip, the captured
issue paths) on its resolved result for every non-throwing terminal
(`produced`, `skipped`). `synthesizeRun` SHALL populate the `validationAttempts`
field on the `skipped` progress emission (`onProgress("skipped", …)`) from that
count. This telemetry SHALL NOT alter the classified outcome, the persisted
`synthesis_status`/`synthesis_reason`, or the re-throw-on-failure invariant — it
is additive observability only.

#### Scenario: A blocker skip surfaces the rejection count on progress

- **GIVEN** the synthesizer submitted twice, was rejected both times, then called `report_blocker`
- **WHEN** `synthesizeRun` resolves to `skipped_blocker`
- **THEN** the `onProgress("skipped", …)` emission carries `validationAttempts` = 2

#### Scenario: A clean blocker reports zero rejections

- **GIVEN** the synthesizer called `report_blocker` without any prior `submit_synthesis` call
- **WHEN** `synthesizeRun` resolves to `skipped_blocker`
- **THEN** the `onProgress("skipped", …)` emission carries `validationAttempts` = 0

## MODIFIED Requirements

### Requirement: Non-fatal synthesis skips are logged

Both non-fatal skip paths (`skipped_no_summaries`, `skipped_blocker`) SHALL emit
a `logger.warn` through the injected `Logger` (namespace `synthesize-run`),
carrying `runId` and the skip reason as structured fields. A skip is an anomaly
worth an operator's attention — it SHALL NOT be silent in logs. The `produced`
path SHALL NOT warn. A `skipped_blocker` warn SHALL additionally carry the count
of `submit_synthesis` rejections that preceded the blocker and a summary of the
rejected validation issue paths, so an operator can distinguish a blocker reached
by misjudgment (zero rejections) from one reached by defensive give-up (repeated
rejections). Identifiers, counts, and issue-path summaries ride as structured
fields, never interpolated into the message text.

#### Scenario: A blocker skip warns with the reason and attempt telemetry

- **WHEN** `synthesizeRun` resolves to `skipped_blocker`
- **THEN** a `warn` record is emitted with `runId`, the blocker reason, the count of `submit_synthesis` rejections, and a summary of the rejected issue paths as fields

#### Scenario: A no-summaries skip warns

- **WHEN** `synthesizeRun` resolves to `skipped_no_summaries`
- **THEN** a `warn` record is emitted with `runId` and a `no-summaries` reason
