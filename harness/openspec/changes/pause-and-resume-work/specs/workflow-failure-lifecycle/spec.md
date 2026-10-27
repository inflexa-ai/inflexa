## ADDED Requirements

### Requirement: The run row exists before the body of the workflow runs

The `cortex_runs` row SHALL be reserved by `execute_analysis` at the async edge
for either mode — BEFORE `DBOS.startWorkflow` launches `executeAnalysis`. The
workflow body's `validateAndInit` SHALL NOT insert the row; it only sanity-checks
that the pre-inserted row matches its `analysisId`, `planId`, and `runId`.
Because the row always pre-exists, `collectAndComplete` always has a row to
finalise — there is no "no row to update" terminal path.

`RunAuthorizer.authorize` is a gate (see the `host-hooks` capability). If
`authorize` gives an `err` for a new run row, `execute_analysis` MUST NOT start
the workflow, and that row MUST NOT stay `running`. For each value of
`suspend`, `execute_analysis` MUST set that row to `"failed"`, with the reason
of the host as its error. No work exists yet, thus the refusal does not pause
(see the `work-pause` capability). `execute_analysis` MUST NOT mark the
analysis. The tool result MUST carry the reason of the host.

#### Scenario: Plan mode reserves the row before launch

- **WHEN** `execute_analysis` plan mode is invoked for a validated plan with no active run
- **THEN** it inserts the `cortex_runs` row with `status = "running"` and a bare-UUID `runId`, authorizes the run, and only then starts `executeAnalysis` under that same `runId`

#### Scenario: Ad hoc mode reserves by invocation identity

- **WHEN** `execute_analysis` ad hoc mode has persisted its internal plan
- **THEN** it idempotently reserves the invocation-derived `runId`, authorizes a newly reserved run, and only then starts `executeAnalysis` under that same id

#### Scenario: Run authorization failure never starts a workflow

- **WHEN** `runAuthorizer.authorize` gives an `err` with `suspend: false` after a new run row was reserved
- **THEN** `execute_analysis` updates that row to `status = "failed"` with the reason of the host as its error, and the tool result carries that reason
- **AND** no `executeAnalysis` workflow is started, so `collectAndComplete` never runs for it

#### Scenario: A run authorization refused with a suspension fails the row

- **WHEN** `runAuthorizer.authorize` gives an `err` with `suspend: true` after `execute_analysis` reserved a new run row
- **THEN** `execute_analysis` sets that row to `"failed"` with the reason of the host as its error and `completed_at` set
- **AND** the status of the analysis does not change
- **AND** no `executeAnalysis` workflow starts, and the tool result carries the reason of the host

### Requirement: collectAndComplete derives the terminal status of the run

`collectAndComplete` MUST set `cortex_runs.status` through `deriveFinalStatus`,
unless an override applies. The synthesis-failure requirement and the charge-open
requirement give the overrides. `deriveFinalStatus` MUST return one of
`"completed"`, `"partial"`, `"failed"`, or `"canceled"`. It MUST apply these
rules in this order:

- If a step failed, the status is `"partial"` when at least one step completed. Otherwise, the status is `"failed"`.
- If the run has a canceled step, the status is `"canceled"`.
- If all steps completed, the status is `"completed"`. If fewer steps completed than the plan holds, the status is `"partial"`.

The status write SHALL run inside a `DBOS.runStep` named `persist-final-status`.
The step MUST retry a failed write with backoff. It MUST make at most 5
attempts. The first wait is 1 second, and each next wait is two times the wait
before it. A cancel of the workflow MUST stop the retries. A refused write MUST
NOT retry.

The last failed attempt MUST NOT fail the step. The step SHALL log the failure
with the `runId` and status, without masking the workflow error, and it MUST
give a failed result. A replay MUST give the same result. The body MUST then
take the failed-write path of "The body owns the end of the run unless the
canceler wins the row".

An attempt can emit `run_completed` in its transaction, and then its commit can
fail. A later attempt of the same execution MUST NOT emit `run_completed` again.

The status write MUST remove each NUL character from the error text before it
writes the row. The database rejects a NUL in text, thus the write cannot fail
for its own values.

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

#### Scenario: persist-final-status failure does not mask the workflow error

- **GIVEN** a run whose synthesis failed
- **WHEN** each attempt of the status write of `persist-final-status` fails
- **THEN** the error is logged with the `runId` and intended status
- **AND** the body still throws the synthesis error, and the DBOS workflow record keeps it

#### Scenario: An error text with a NUL character is written without it

- **GIVEN** a failure reason that holds a NUL character
- **WHEN** the status write of `persist-final-status` writes the status `failed`
- **THEN** the write changes the row, and the error of the row is the failure reason with no NUL character

#### Scenario: A transient failure of the status write retries

- **GIVEN** a `running` run row
- **WHEN** the first attempt of the status write fails and the second attempt changes the row to `completed`
- **THEN** the row holds `completed`
- **AND** the step closes the charge with `{ kind: "ok" }` and revokes the run authorization one time
- **AND** no `close-running-charge` or `revoke-run-auth` step runs

#### Scenario: A failed commit after the emit does not emit again

- **GIVEN** an attempt of the status write that emits `run_completed` and whose commit then fails
- **WHEN** the next attempt changes the row
- **THEN** the run emit holds one `run_completed` event for the execution

#### Scenario: A cancel stops the retries

- **GIVEN** a status write whose first attempt failed before its emit
- **WHEN** an engine cancel of the parent lands before the next attempt
- **THEN** the next attempt does not run, and the body stops with the engine cancel
- **AND** the body closes no charge, revokes no authorization, and emits no `run_completed` event

#### Scenario: A late status write keeps the cancel of the canceler

- **GIVEN** a `persist-final-status` step that started before an engine cancel
- **AND** the run canceler then changed the run row to `canceled`
- **WHEN** the step writes the status `completed`
- **THEN** the run row keeps the status `canceled` and the error `external_cancel`
- **AND** the step records no run outcome metric and no step outcome metric

#### Scenario: A won status write records the outcome one time

- **WHEN** the `persist-final-status` step changes a `running` row to `partial`
- **THEN** the step records one run outcome metric with the status `partial`

### Requirement: A synthesis failure gives a failed terminal status

When the parent's `synthesizeFindings` step throws, the body MUST pass
`forceFailed: true` to `collectAndComplete`. `collectAndComplete` MUST then set the
status to `"failed"`. A synthesis failure is terminal. `collectAndComplete` MUST still
close the charge with the outcome `{ kind: "error" }`, and it MUST revoke the run
authorization. The body MUST then re-throw the synthesis error, thus the DBOS
workflow record goes to `ERROR`.

A failure of the synthesis with a cause of a pause is not a synthesis failure,
and this rule does not apply to it. The synthesis pauses, and it sends the
request again after the resume (see the `work-pause` capability).

#### Scenario: Synthesis throws after steps completed

- **WHEN** `synthesizeFindings` throws and at least one step had completed
- **THEN** `collectAndComplete` sets `cortex_runs.status = "failed"` with the `synthesis-failed: …` error, closes the charge and revokes authorization, and the body re-throws so the workflow record is `ERROR`

#### Scenario: A synthesis that pauses does not fail the run

- **GIVEN** each step completed, and a model request of the synthesis fails with a `suspend` error
- **WHEN** the user resumes the run
- **THEN** the synthesis sends the request again, and `collectAndComplete` runs after the synthesis ends
- **AND** the run row stays `running` during the pause

## MODIFIED Requirements

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

#### Scenario: A suspended synthesis leaves the columns unknown

- **WHEN** a model request of the synthesis fails with a `suspend` error, and the synthesis waits in `paused`
- **THEN** the run's `synthesis_status` and `synthesis_reason` remain NULL during the pause

### Requirement: collectAndComplete is the single finalisation hook

Within the `executeAnalysis` body, `collectAndComplete` MUST be the only block
that writes the terminal run-level state. Two writers act outside a workflow
body: the authorization refusal of `execute_analysis`, where no workflow starts
(see "The run row exists before the body of the workflow runs"), and the run canceler
after an engine cancel of the parent (see the `run-cancellation` capability).
An engine cancel of the parent stops its body, thus `collectAndComplete` does
not run on that path. `collectAndComplete` MUST run on each terminal path of
the body:

- success
- a run with step failures, which drains the scheduler loop and usually ends `partial`
- the budget halt
- a canceled step, while the parent itself continues
- synthesis failure
- a refused charge open (see "The run opens its charge through a gate before a step starts")

Within it, the status write, the charge close, and the run-authorization revoke
MUST each run inside a named `DBOS.runStep`. When the status write changes the
row, the charge close and the revoke MUST run inside the same step as the write,
`persist-final-status`. When the status write is refused or fails, the charge
close and the revoke MUST each run in their own named step,
`close-running-charge` and `revoke-run-auth`. The requirement "The body owns the
end of the run unless the canceler wins the row" gives the reason. The body MUST
log a failure of one of these acts, and it MUST NOT roll back the side effects
that did succeed. There SHALL be NO separate `onError`-style hook racing it; child
step bodies SHALL NOT call `updateRunStatus` or any run-fail helper directly.

`RunCharge.close` and `RunAuthorizer.revoke` are notices (see the `host-hooks`
capability). If a notice gives an `err`, `collectAndComplete` MUST log the reason
at the error level. The terminal status of the run MUST NOT change, and the other
steps of `collectAndComplete` MUST still run.

`collectAndComplete` MUST close the running charge with the outcome that matches
the terminal status:

- `{ kind: "ok" }` for `"completed"` and `"partial"`
- `{ kind: "error" }` for `"failed"`
- `{ kind: "canceled" }` for `"canceled"`

On its genuinely-terminal paths (success, runs with step failures, a canceled
step, synthesis failure) `collectAndComplete` SHALL additionally sweep the
run's still-`pending` step rows to `skipped` (stamping `completed_at`) in its
own named `DBOS.runStep`, so a finished run never advertises steps that read as
still waiting to start — including dependents that were never dispatched
because an upstream step failed or blocked. A sweep-step failure SHALL be logged
without rolling back the other finalisation side effects, matching the hook's
non-rolling-back rule.

#### Scenario: Step bodies do not write run status

- **WHEN** a child workflow body encounters an error
- **THEN** the body lets the error propagate (it does not write `cortex_runs.status`)
- **AND** the parent's `collectAndComplete` owns the run-status transition

#### Scenario: A partial finalisation failure is non-rolling-back

- **WHEN** the charge close succeeds but `RunAuthorizer.revoke` gives an `err`
- **THEN** the revoke failure is logged with the `runId` and reason
- **AND** the already-closed charge and already-written status are not rolled back

#### Scenario: A charge close failure does not change the run status

- **WHEN** `RunCharge.close` gives an `err` on a terminal path
- **THEN** `collectAndComplete` logs the reason of the `err` at the error level
- **AND** the written run status does not change, and `collectAndComplete` still revokes the run authorization

#### Scenario: Unreachable dependents are swept to skipped

- **GIVEN** a plan `A → B → D` and `A → C → E` where B failed, D was therefore never dispatched, and C and E completed
- **WHEN** `collectAndComplete` runs after the scheduler loop drains
- **THEN** D's seeded `pending` row reaches `status="skipped"` with `completed_at` stamped and the run finalises `partial`

#### Scenario: A suspension preserves pending rows

- **GIVEN** a run whose step waits in `paused`, with unstarted steps seeded `pending`
- **WHEN** the pause lasts
- **THEN** `collectAndComplete` does not run, and the `pending` rows are left untouched for the resumed run

### Requirement: The body owns the end of the run unless the canceler wins the row

The run body and the run canceler race at the end of a run, and the first
terminal write of the run row wins. The writer that wins the row owns each act
of the run end: the `run_completed` emit, the charge close, and the
run-authorization revoke. When the status write of the body fails, no writer
owns the row, and the body owns the run end. The body MUST do these acts only
as the owner of the row, or after its status write failed.

The body MUST NOT emit `run_completed` before its status write. When the write
of `persist-final-status` changes the row, the same step MUST do these acts, in
this order:

1. It emits `run_completed` with the status of the body. The emit MUST occur
   before another reader can see the terminal status of the row.
2. It records the outcome metrics.
3. It closes the running charge with the outcome of the status.
4. It revokes the run authorization.

These acts come before `persist-synthesis-outcome` and `sweep-pending-steps`.

The emit order lets a host that exits when its poll sees a terminal row flush
the run end first. An engine cancel cannot stop a step that started, thus a
cancel cannot cut the body between its won write and these acts.

When a recovery replays the body and gives the won step from the cache, the
body MUST emit `run_completed` again, outside the step. The event MUST carry the
same status, `atMs`, and `durationMs`. The body MUST NOT close the charge or
revoke the authorization again.

When the status write is refused or fails, the body MUST close the charge in
the `close-running-charge` step, and then revoke the authorization in the
`revoke-run-auth` step. Then it MUST emit `run_completed`, unless an attempt of
the status step emitted it in this execution. A refused write has
two causes:

- The run canceler won the row. The canceler cancels the engine before its
  write, thus the `close-running-charge` step throws the engine cancel. The
  body then stops, and it does no act of the run end.
- A recovery runs the status step again after its own write landed and before
  the step was recorded. The body owns the row, thus it completes the run end.

After a failed write, the row stays `running`. Thus, after the emit, the body
MUST record its run end in the durability engine. The record is a workflow
event that holds these values:

- the status and the error that the failed write tried to write
- the result of the charge close, and the result of the revoke.

The run canceler reads it, and then it does no act of the run end (see the
`run-cancellation` capability). The body MUST NOT record a run end after a won
or a refused write.

The record MUST come after the charge close, the revoke, and the emit. A cancel
that lands before the record stops the body, thus the body records nothing, and
the canceler owns the rest of the run end. A failure of the record other than
the cancel MUST go to the log, and the body MUST continue with its next
terminal step.

One race keeps two run ends. An attempt emits `run_completed`, its commit
fails, and an engine cancel lands before the next attempt. The canceler then
wins the row and records the second run end. The emit before the commit causes
this race, and this requirement accepts it.

#### Scenario: A won status write emits one run end before the row shows it

- **WHEN** the status write of `persist-final-status` changes a `running` row to `completed`
- **THEN** the run emit receives one `run_completed` event with the status `completed`
- **AND** the emit occurs before another reader can see the status `completed` on the row
- **AND** the same step closes the charge with `{ kind: "ok" }` and revokes the run authorization with `workflow-completed`

#### Scenario: An engine cancel does not cut the acts of a won write

- **GIVEN** a `persist-final-status` step whose write changed the row to `completed`
- **WHEN** an engine cancel of the parent lands before the step ends
- **THEN** the step still closes the charge with `{ kind: "ok" }` and revokes the run authorization

#### Scenario: A write that the canceler refused leaves the run end to the canceler

- **GIVEN** the run canceler canceled the engine and changed the row to `canceled`
- **WHEN** the status write of the body changes nothing
- **THEN** the body emits no `run_completed` event
- **AND** the `close-running-charge` step throws the engine cancel, thus the body closes no charge and revokes no authorization

#### Scenario: A recovery after the own write landed completes the run end

- **GIVEN** a `persist-final-status` step whose write landed before a crash, and whose result DBOS did not record
- **WHEN** the recovery runs the step again and the write changes nothing
- **THEN** the body closes the charge in `close-running-charge` and revokes the authorization in `revoke-run-auth`
- **AND** the body emits `run_completed` with the `atMs` of the terminal clock read of the first execution

#### Scenario: A replay of a won step emits the run end again

- **WHEN** a recovery replays the body and DBOS gives the won `persist-final-status` step from the cache
- **THEN** the body emits `run_completed` again with the same status, `atMs`, and `durationMs`
- **AND** the body does not close the charge or revoke the authorization again

#### Scenario: A failed status write still closes the charge

- **WHEN** each attempt of the status write of `persist-final-status` fails
- **THEN** the body logs the failure with the `runId` and the status
- **AND** the body closes the charge in `close-running-charge`, revokes the authorization in `revoke-run-auth`, and then emits `run_completed`

#### Scenario: A failed status write records the run end

- **WHEN** each attempt of the status write of `persist-final-status` fails
- **THEN** after the emit, the body records its run end in the engine, with the status and the error of the failed write, and with the results of the charge close and the revoke

#### Scenario: A failed commit after the emit, then a cancel, keeps two run ends

- **GIVEN** an attempt of the status write that emits `run_completed` and whose commit then fails
- **WHEN** an engine cancel of the parent lands before the next attempt
- **THEN** the body stops with the engine cancel, and it records no run end in the engine

#### Scenario: A won or a refused write records no run end

- **WHEN** the status write of `persist-final-status` changes the row, or changes nothing
- **THEN** the body records no run end in the engine

#### Scenario: A failed record does not stop the body

- **GIVEN** a status write that failed on each attempt
- **WHEN** the record of the run end fails with an error that is not a cancel
- **THEN** the body logs the failure, and it continues with its next terminal step

### Requirement: The run opens its charge through a gate before a step starts

`validateAndInit` MUST open the running charge through `RunCharge.open`, in a
`DBOS.runStep` named `open-running-charge`, before the parent starts a step.
`RunCharge.open` is a gate that gives no value (see the `host-hooks` capability).
The parent MUST NOT start a step before the charge opens.

If `RunCharge.open` gives an `err` with `suspend: false`, `collectAndComplete`
MUST set the run status to `"failed"`, with the reason of the host as the failure
reason. It MUST NOT derive that status from the step counts.

If the `err` has `suspend: true`, the run MUST pause at the gate with the cause
`host` and the reason of the host (see the `work-pause` capability). After the
resume, `validateAndInit` MUST open the charge again.

#### Scenario: A refused charge fails the run before a step starts

- **GIVEN** a `RunCharge` whose `open` gives an `err` with `suspend: false`
- **WHEN** `executeAnalysis` opens the running charge
- **THEN** no step starts, and the run row reaches `"failed"` with the reason of the host as its error
- **AND** `collectAndComplete` revokes the run authorization

#### Scenario: A refused charge with a suspension suspends the run

- **GIVEN** a `RunCharge` whose `open` gives an `err` with `suspend: true`, and then `ok`
- **WHEN** `executeAnalysis` opens the running charge, and the user resumes the run
- **THEN** no step starts before the second open, and the steps start after it
- **AND** the run row stays `running`, and the status of the analysis does not change

## REMOVED Requirements

### Requirement: The run row exists before the workflow body runs

**Reason**: Its scenarios of a suspension describe a state that no longer exists. A MODIFIED block cannot drop a scenario, thus the requirement "The run row exists before the body of the workflow runs" replaces it.

**Migration**: Refer to "The run row exists before the body of the workflow runs" in this capability.

### Requirement: collectAndComplete derives the terminal run status

**Reason**: Its scenarios of a suspension describe a state that no longer exists. A MODIFIED block cannot drop a scenario, thus the requirement "collectAndComplete derives the terminal status of the run" replaces it.

**Migration**: Refer to "collectAndComplete derives the terminal status of the run" in this capability.

### Requirement: An insufficient-budget pause is suspended and made resumable

**Reason**: A run does not end for a suspension. Its step or its synthesis waits in place, and it sends the request again after the resume of the user.

**Migration**: Refer to the `work-pause` capability. A versioned migration moves each run row `suspended_insufficient_funds` to `failed`, and each analysis row `suspended_insufficient_funds` to `active`.

### Requirement: A synthesis failure forces a failed terminal status

**Reason**: Its scenarios of a suspension describe a state that no longer exists. A MODIFIED block cannot drop a scenario, thus the requirement "A synthesis failure gives a failed terminal status" replaces it.

**Migration**: Refer to "A synthesis failure gives a failed terminal status" in this capability.
