## Purpose

Defines the observable contract for how a DBOS `executeAnalysis` run reaches a
terminal state — the full terminal-status set, how partial results are rescued
rather than discarded, how an insufficient-budget pause is made resumable, and
the ordering guarantees around the single finalisation hook.

The central design choice is that **terminal state is derived, not asserted by
step bodies**. `collectAndComplete` is the one block that finalises run-level
state on every path (success, fail-fast, external cancel, synthesis failure,
and the 402 budget pause). Step bodies never call `updateRunStatus`; they let
errors propagate, and the parent's `try`/`finally` structure guarantees
`collectAndComplete` runs last. This keeps the run row, the running charge, the
run authorization, and the terminal stream part consistent under DBOS recovery,
because each finalisation side effect is its own named `DBOS.runStep` and
replays from cache instead of repeating.

A run is **not all-or-nothing**. `deriveFinalStatus` maps the completed / failed
/ canceled step counts onto a five-value status so a run that produced real
outputs before a failure is preserved as `partial` rather than thrown away as
`failed`. The durable-runtime contract (scheduler, fail-fast cascade, child
cancellation) is owned by the harness-durable-runtime spec; this spec covers the
terminal transition those mechanisms feed into.
## Requirements
### Requirement: The run row exists before the workflow body runs

The `cortex_runs` row SHALL be inserted by `executePlan` at the async edge —
BEFORE `DBOS.startWorkflow` launches `executeAnalysis`. The workflow body's
`validateAndInit` SHALL NOT insert the row; it only sanity-checks that the
pre-inserted row is the active run for its `(analysisId, planId)`. Because the
row always pre-exists, `collectAndComplete` always has a row to finalise — there
is no "no row to update" terminal path.

#### Scenario: executePlan reserves the row before launch

- **WHEN** `executePlan` is invoked for a validated plan with no active run
- **THEN** it inserts the `cortex_runs` row with `status = "running"` and the bare-UUID `runId`, authorizes the run, and only then starts the `executeAnalysis` workflow under that same `runId`

#### Scenario: Run authorization failure never starts a workflow

- **WHEN** `runAuthorizer.authorize` throws after the run row was reserved
- **THEN** `executePlan` updates that row to `status = "failed"` with error `"run authorization failed"` (releasing the partial-unique slot) and rethrows
- **AND** no `executeAnalysis` workflow is started, so `collectAndComplete` never runs for it

### Requirement: collectAndComplete derives the terminal run status

`collectAndComplete` SHALL set `cortex_runs.status` via `deriveFinalStatus`
(unless overridden — see the synthesis-failure requirement). `deriveFinalStatus`
SHALL return one of `"completed"`, `"partial"`, `"failed"`, or `"canceled"`:
a budget pause yields `"canceled"`; any failed step with at least one completed
step yields `"partial"` (otherwise `"failed"`); any canceled step yields
`"canceled"`; and an all-steps-completed run yields `"completed"`, while
completed-but-fewer-than-total yields `"partial"`. The status write SHALL run
inside a `DBOS.runStep` named `persist-final-status`, and a failure of that step
SHALL be logged with the `runId` and status without masking the workflow error.

#### Scenario: Some steps fail after others completed

- **GIVEN** a run where step A completed and step B failed
- **WHEN** `collectAndComplete` runs
- **THEN** `deriveFinalStatus` returns `"partial"` and `cortex_runs.status = "partial"` with `completed_at` set
- **AND** a `data-run-completed` part is emitted carrying a note that results are partial

#### Scenario: All steps complete

- **WHEN** every step in the plan completed and synthesis succeeded
- **THEN** `cortex_runs.status = "completed"` and `completed_at` is set

#### Scenario: persist-final-status failure does not mask the workflow error

- **WHEN** the `persist-final-status` step itself throws
- **THEN** the error is logged with the `runId` and intended status
- **AND** the underlying workflow error is preserved in the DBOS workflow record

### Requirement: An insufficient-budget pause is suspended and made resumable

On the 402 budget-pause path, `collectAndComplete` SHALL suspend the run rather
than terminally fail it. When a child self-cancels with `budget_exceeded` and
synthesis did not fail, it SHALL set the run row to `"canceled"`, flip the
analysis row to `status = "suspended_insufficient_funds"` via `suspendAnalysis`
in a `DBOS.runStep` named `suspend-analysis`, close the running charge with reason
`budget_exceeded`, and emit a `data-run-failed` part with `reason:
"budget_exceeded"`. The parent body SHALL then self-cancel via `DBOS.cancelWorkflow`
(to `CANCELLED`, never `ERROR`) so the paused parent stays DBOS-resumable.
`suspended_insufficient_funds` is a member of the run-status enum and gates the
active-run partial-unique index, so a paused run still counts as active and blocks
a duplicate launch.

Resuming a paused run after a top-up is a DEFERRED enhancement: no resume entry
point is wired, and the attempt-numbered step-name cache-busting a correct resume
requires was removed with the resume scaffolding. Until that lands, a paused run
stays `suspended_insufficient_funds` and is not re-driven.

#### Scenario: Budget exhaustion pauses the analysis

- **GIVEN** a child step self-cancels with `budget_exceeded` and synthesis has not failed
- **WHEN** `collectAndComplete` runs
- **THEN** the run row reaches `"canceled"`, the analysis row reaches `"suspended_insufficient_funds"`, the running charge is closed with reason `budget_exceeded`, and the parent self-cancels to `CANCELLED`

### Requirement: A synthesis failure forces a failed terminal status

When the parent's `synthesizeFindings` step throws, the body SHALL pass
`forceFailed: true` to `collectAndComplete`, which SHALL override the derived
status to `"failed"` even when the budget was also exceeded — a synthesis
failure is definitively terminal, never a resumable pause. `collectAndComplete`
SHALL still close the charge (reason `error`) and revoke the run authorization
before the body re-throws the synthesis error so the DBOS workflow record goes to
`ERROR`.

#### Scenario: Synthesis throws after steps completed

- **WHEN** `synthesizeFindings` throws and at least one step had completed
- **THEN** `collectAndComplete` sets `cortex_runs.status = "failed"` with the `synthesis-failed: …` error, closes the charge and revokes authorization, and the body re-throws so the workflow record is `ERROR`

#### Scenario: Synthesis failure beats a concurrent budget pause

- **GIVEN** the budget was exceeded AND synthesis also threw
- **WHEN** `collectAndComplete` runs with `forceFailed: true`
- **THEN** the run is `"failed"` (not suspended) and the parent does not self-cancel for resumption

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

### Requirement: collectAndComplete is the single finalisation hook

`collectAndComplete` SHALL be the only block that finalises run-level state, and
it SHALL run on every terminal path: success, runs with step failures (which
drain the scheduler loop and typically finalise `partial`), the budget halt,
external cancel, synthesis failure, and the 402 pause. Within it the status
write, charge close, and run-authorization revoke SHALL each be their own named
`DBOS.runStep`, and a failure of any one SHALL be logged without rolling back
the side effects that did succeed. There SHALL be NO separate `onError`-style
hook racing it; child step bodies SHALL NOT call `updateRunStatus` or any
run-fail helper directly.

On its genuinely-terminal paths (success, runs with step failures, external
cancel, synthesis failure) `collectAndComplete` SHALL additionally sweep the
run's still-`pending` step rows to `skipped` (stamping `completed_at`) in its
own named `DBOS.runStep`, so a finished run never advertises steps that read as
still waiting to start — including dependents that were never dispatched
because an upstream step failed or blocked. The sweep SHALL NOT run on the
resumable 402 budget-pause branch — the branch is selected structurally (the
pause path itself), never inferred from the written run status (the pause also
writes `"canceled"`) — because the resumed workflow still needs those `pending`
rows. A sweep-step failure SHALL be logged without rolling back the other
finalisation side effects, matching the hook's non-rolling-back rule.

#### Scenario: Step bodies do not write run status

- **WHEN** a child workflow body encounters an error
- **THEN** the body lets the error propagate (it does not write `cortex_runs.status`)
- **AND** the parent's `collectAndComplete` owns the run-status transition

#### Scenario: A partial finalisation failure is non-rolling-back

- **WHEN** the charge close succeeds but the run-authorization revoke step throws
- **THEN** the revoke failure is logged with the `runId` and reason
- **AND** the already-closed charge and already-written status are not rolled back

#### Scenario: Unreachable dependents are swept to skipped

- **GIVEN** a plan `A → B → D` and `A → C → E` where B failed, D was therefore never dispatched, and C and E completed
- **WHEN** `collectAndComplete` runs after the scheduler loop drains
- **THEN** D's seeded `pending` row reaches `status="skipped"` with `completed_at` stamped and the run finalises `partial`

#### Scenario: The budget pause preserves pending rows

- **GIVEN** a run paused on the 402 budget path with unstarted steps seeded `pending`
- **WHEN** `collectAndComplete` runs on the pause branch
- **THEN** the `pending` rows are left untouched for the resumed workflow to execute

