## Purpose

Defines how a run's literature-grounded synthesis reports its outcome, so that a
skipped or failed synthesis is never indistinguishable from a clean success and
consumers never read a phantom `synthesis.json`.

Run synthesis has three terminal shapes: it produced a synthesis, it skipped
(no summaries to integrate, or the synthesizer reported a blocker), or it failed
(threw). Historically the two skip shapes returned an empty result silently — no
log, no distinct run status, no file — and `inspect_run` advertised a synthesis
path for any completed run regardless. This spec makes the outcome explicit: it
is classified, logged when it is a skip, recorded on the run ledger
(`run-state-persistence`, `workflow-failure-lifecycle`), and surfaced to
consumers, which key on the recorded outcome rather than the presence of a
mutable disk file. The disk `synthesis.json` remains the content store; the run
row is the authority on whether that content exists.

## Requirements

### Requirement: Run synthesis resolves to a classified outcome

Run synthesis SHALL resolve every terminal to a classified outcome instead of
flattening the non-fatal terminals to an empty result. `synthesizeRun` (and the
`synthesizeFindings` wrapper the parent workflow calls) SHALL return this
outcome, which SHALL be one of:

- `produced` — the synthesizer submitted a valid synthesis; `synthesis.json` is
  persisted and the findings are returned.
- `skipped_no_summaries` — no step summary loaded from disk; nothing to
  synthesize.
- `skipped_blocker` — the synthesizer called `report_blocker`; the carried reason
  is the blocker reason.
- `failed` — synthesis threw; the error re-propagates so the run fails (per
  `workflow-failure-lifecycle`), and the outcome carries the failure reason.

The outcome SHALL carry an optional human-readable `reason` for every non-
`produced` variant. The `produced` and `skipped_*` variants SHALL resolve
normally (no throw); only `failed` re-throws. The quick-display `findings` SHALL
remain empty for every non-`produced` outcome.

#### Scenario: Blocker resolves to a skipped_blocker outcome

- **GIVEN** step summaries loaded and the synthesizer called `report_blocker` with a reason
- **WHEN** `synthesizeRun` resolves
- **THEN** the outcome is `skipped_blocker` with `reason` = the blocker reason, `findings` is empty, and no `synthesis.json` is written

#### Scenario: No summaries resolves to a skipped_no_summaries outcome

- **GIVEN** no step summary loaded from disk for the completed steps
- **WHEN** `synthesizeRun` resolves
- **THEN** the outcome is `skipped_no_summaries`, `findings` is empty, and no synthesizer agent loop runs

#### Scenario: A valid submission resolves to a produced outcome

- **WHEN** the synthesizer submits a schema-valid, semantically-valid synthesis
- **THEN** the outcome is `produced`, `synthesis.json` is persisted under `runs/{runId}/`, and the findings are returned

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

### Requirement: inspect_run gates the synthesis path on the produced outcome

`inspect_run` SHALL advertise a `synthesisPath` (`runs/{runId}/synthesis.json`)
for a run ONLY when that run's `synthesis_status` is `produced` — never merely
because the run `status` is `completed`. For any other `synthesis_status`
(including NULL/unknown), `synthesisPath` SHALL be `null`. `inspect_run` SHALL
additionally surface `synthesisStatus` and, when present, `synthesisReason` in
the formatted run, so a consumer can distinguish "synthesis produced" from
"synthesis skipped/failed" without reading a file.

#### Scenario: Completed run whose synthesis was skipped advertises no path

- **GIVEN** a run with `status = "completed"` and `synthesis_status = "skipped_blocker"`
- **WHEN** `inspect_run` formats that run
- **THEN** `synthesisPath` is `null`, `synthesisStatus` is `"skipped_blocker"`, and `synthesisReason` is the recorded reason

#### Scenario: Completed run with produced synthesis advertises the path

- **GIVEN** a run with `status = "completed"` and `synthesis_status = "produced"`
- **WHEN** `inspect_run` formats that run
- **THEN** `synthesisPath` is `runs/{runId}/synthesis.json` and `synthesisStatus` is `"produced"`

#### Scenario: Legacy completed run with unknown synthesis advertises no path

- **GIVEN** a pre-migration run with `status = "completed"` and `synthesis_status = NULL`
- **WHEN** `inspect_run` formats that run
- **THEN** `synthesisPath` is `null` and `synthesisStatus` is `null`

### Requirement: Conversation guidance treats synthesis as present only when produced

The conversation agent's "Interpreting Results" guidance SHALL describe
`synthesis.json` as available only when the run reports its synthesis was
produced, and SHALL direct the agent to fall back to the per-step `summary.md`
files when synthesis was skipped or failed — rather than presenting
`synthesis.json` as an unconditional "primary source" for any completed run.

#### Scenario: Guidance directs a fallback on a skipped synthesis

- **WHEN** the conversation guidance is composed
- **THEN** it states that `synthesis.json` exists only for a run whose synthesis was produced, and that step summaries are the fallback when it was not
