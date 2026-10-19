## MODIFIED Requirements

### Requirement: collectAndComplete derives the terminal run status

`collectAndComplete` MUST set `cortex_runs.status` through `deriveFinalStatus`,
unless an override applies. The synthesis-failure requirement and the charge-open
requirement give the overrides. `deriveFinalStatus` MUST return one of
`"completed"`, `"partial"`, `"failed"`, `"canceled"`, or
`"suspended_insufficient_funds"`. It MUST apply these rules in this order:

- A suspension gives `"suspended_insufficient_funds"`.
- If a step failed, the status is `"partial"` when at least one step completed. Otherwise, the status is `"failed"`.
- If the run has a canceled step, the status is `"canceled"`.
- If all steps completed, the status is `"completed"`. If fewer steps completed than the plan holds, the status is `"partial"`.

The status write SHALL run inside a `DBOS.runStep` named `persist-final-status`,
and a failure of that step SHALL be logged with the `runId` and status without
masking the workflow error.

The status write MUST change the run row only when the row is still `running`.
The run canceler can write `canceled` after an engine cancel, while a
`persist-final-status` step that started before the cancel still runs. In that
case the row MUST keep `canceled`. Of these two terminal writes, the first wins.

The `persist-final-status` step records the run outcome metric. It also records
the outcome metric of each settled step whose child wrote no terminal row. The
step MUST record these metrics only when its write changed the row. Thus the
writer that wins the row records the outcome of the run one time. A refused
write MUST NOT fail the step, and the body MUST continue with its next terminal
step.

#### Scenario: Some steps fail after others completed

- **GIVEN** a run where step A completed and step B failed
- **WHEN** `collectAndComplete` runs
- **THEN** `deriveFinalStatus` returns `"partial"` and `cortex_runs.status = "partial"` with `completed_at` set
- **AND** a `data-run-completed` part is emitted carrying a note that results are partial

#### Scenario: All steps complete

- **WHEN** every step in the plan completed and synthesis succeeded
- **THEN** `cortex_runs.status = "completed"` and `completed_at` is set

#### Scenario: A suspension outranks the step outcomes

- **GIVEN** a run where step A completed, step B suspended, and step C was canceled by the parent
- **WHEN** `collectAndComplete` runs and synthesis did not fail
- **THEN** `deriveFinalStatus` returns `"suspended_insufficient_funds"`

#### Scenario: persist-final-status failure does not mask the workflow error

- **WHEN** the `persist-final-status` step fails
- **THEN** the error is logged with the `runId` and intended status
- **AND** the underlying workflow error is preserved in the DBOS workflow record

#### Scenario: A late status write keeps the cancel of the canceler

- **GIVEN** a `persist-final-status` step that started before an engine cancel
- **AND** the run canceler then changed the run row to `canceled`
- **WHEN** the step writes the status `completed`
- **THEN** the run row keeps the status `canceled` and the error `external_cancel`
- **AND** the step records no run outcome metric and no step outcome metric

#### Scenario: A won status write records the outcome one time

- **WHEN** the `persist-final-status` step changes a `running` row to `partial`
- **THEN** the step records one run outcome metric with the status `partial`
