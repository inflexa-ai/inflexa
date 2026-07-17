## ADDED Requirements

### Requirement: collectAndComplete records the run synthesis outcome

`collectAndComplete` SHALL persist the run's synthesis outcome onto the run row
via `setRunSynthesisOutcome` as part of the terminal finalisation, whenever run-
level synthesis ran (`synthesisEnabled` and at least one step completed). The
parent workflow body SHALL thread the synthesizer's classified outcome — one of
`produced`, `skipped_no_summaries`, `skipped_blocker`, or `failed`, with an
optional reason string — into `collectAndComplete`. This composes with, and does
not replace, the existing rule that a thrown synthesis forces `status =
"failed"`: the run status and the synthesis outcome are recorded independently,
so a `failed` synthesis outcome always accompanies a `failed` run status, while a
`skipped_*` outcome may accompany a `completed` run status.

The write SHALL be its own concern within finalisation (log-don't-rollback like
the other terminal writes): a `setRunSynthesisOutcome` failure SHALL be logged
without rolling back the run-status write or the other finalisation steps. When
synthesis did not run for the run (disabled, or no step completed), the synthesis
columns SHALL be left NULL (unknown).

#### Scenario: A produced synthesis is recorded on a completed run

- **WHEN** `synthesizeFindings` returns a `produced` outcome and the run finalises `completed`
- **THEN** `collectAndComplete` persists `synthesis_status = "produced"` and `synthesis_reason = NULL` on the run row

#### Scenario: A blocker skip is recorded on a completed run

- **WHEN** `synthesizeFindings` returns a `skipped_blocker` outcome with a reason and the run finalises `completed`
- **THEN** `collectAndComplete` persists `synthesis_status = "skipped_blocker"` and `synthesis_reason` = the blocker reason, while `status` stays `"completed"`

#### Scenario: A synthesis failure is recorded alongside the failed status

- **WHEN** `synthesizeFindings` throws (forcing `status = "failed"`)
- **THEN** `collectAndComplete` persists `synthesis_status = "failed"` with the failure reason AND sets `status = "failed"`, and the body re-throws so the workflow record is `ERROR`

#### Scenario: Synthesis that never ran leaves the columns unknown

- **WHEN** synthesis is skipped entirely because no step completed (or synthesis is disabled)
- **THEN** the run's `synthesis_status` and `synthesis_reason` remain NULL
