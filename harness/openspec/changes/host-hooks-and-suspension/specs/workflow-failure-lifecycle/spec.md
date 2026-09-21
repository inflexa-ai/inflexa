## ADDED Requirements

### Requirement: The run opens its charge through a gate before a step starts

`validateAndInit` MUST open the running charge through `RunCharge.open`, in a
`DBOS.runStep` named `open-running-charge`, before the parent starts a step.
`RunCharge.open` is a gate that gives no value (see the `host-hooks` capability).
If `RunCharge.open` gives an `err`, the parent MUST NOT start a step.
`collectAndComplete` MUST then write the terminal state of the run.

If the `err` has `suspend: false`, `collectAndComplete` MUST set the run status to
`"failed"`, with the reason of the host as the failure reason. It MUST NOT derive
that status from the step counts. If the `err` has `suspend: true`, the run MUST
suspend with the reason of the host, as "An insufficient-budget pause is suspended
and made resumable" describes.

#### Scenario: A refused charge fails the run before a step starts

- **GIVEN** a `RunCharge` whose `open` gives an `err` with `suspend: false`
- **WHEN** `executeAnalysis` opens the running charge
- **THEN** no step starts, and the run row reaches `"failed"` with the reason of the host as its error
- **AND** `collectAndComplete` revokes the run authorization

#### Scenario: A refused charge with a suspension suspends the run

- **GIVEN** a `RunCharge` whose `open` gives an `err` with `suspend: true`
- **WHEN** `executeAnalysis` opens the running charge
- **THEN** no step starts, and the analysis row reaches `"suspended_insufficient_funds"`
- **AND** the run row reaches `"canceled"` with the reason of the host, and the parent ends in the DBOS state `CANCELLED`

## MODIFIED Requirements

### Requirement: The run row exists before the workflow body runs

The `cortex_runs` row SHALL be reserved by `execute_analysis` at the async edge
for either mode — BEFORE `DBOS.startWorkflow` launches `executeAnalysis`. The
workflow body's `validateAndInit` SHALL NOT insert the row; it only sanity-checks
that the pre-inserted row matches its `analysisId`, `planId`, and `runId`.
Because the row always pre-exists, `collectAndComplete` always has a row to
finalise — there is no "no row to update" terminal path.

`RunAuthorizer.authorize` is a gate (see the `host-hooks` capability). If
`authorize` gives an `err` for a new run row, `execute_analysis` MUST NOT start
the workflow, and that row MUST NOT stay `running`. If the `err` has
`suspend: false`, `execute_analysis` MUST set that row to `"failed"`, with the
reason of the host as its error. If the `err` has `suspend: true`,
`execute_analysis` MUST set that row to `"canceled"`, with the reason of the host
as its error. It MUST also mark the analysis as suspended through the one function
of the `workflow-suspension` capability. In both cases, the tool result MUST carry
the reason of the host.

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

#### Scenario: A run authorization refused with a suspension marks the analysis

- **WHEN** `runAuthorizer.authorize` gives an `err` with `suspend: true` after `execute_analysis` reserved a new run row
- **THEN** `execute_analysis` sets that row to `"canceled"` with the reason of the host as its error, and it marks the analysis as suspended
- **AND** no `executeAnalysis` workflow starts, and the tool result carries the reason of the host

### Requirement: collectAndComplete derives the terminal run status

`collectAndComplete` MUST set `cortex_runs.status` through `deriveFinalStatus`,
unless an override applies. The synthesis-failure requirement and the charge-open
requirement give the overrides. `deriveFinalStatus` MUST return one of
`"completed"`, `"partial"`, `"failed"`, or `"canceled"`. It MUST apply these rules
in this order:

- A suspension gives `"canceled"`.
- If a step failed, the status is `"partial"` when at least one step completed. Otherwise, the status is `"failed"`.
- If the run has a canceled step, the status is `"canceled"`.
- If all steps completed, the status is `"completed"`. If fewer steps completed than the plan holds, the status is `"partial"`.

The status write SHALL run inside a `DBOS.runStep` named `persist-final-status`,
and a failure of that step SHALL be logged with the `runId` and status without
masking the workflow error.

#### Scenario: Some steps fail after others completed

- **GIVEN** a run where step A completed and step B failed
- **WHEN** `collectAndComplete` runs
- **THEN** `deriveFinalStatus` returns `"partial"` and `cortex_runs.status = "partial"` with `completed_at` set
- **AND** a `data-run-completed` part is emitted carrying a note that results are partial

#### Scenario: All steps complete

- **WHEN** every step in the plan completed and synthesis succeeded
- **THEN** `cortex_runs.status = "completed"` and `completed_at` is set

#### Scenario: persist-final-status failure does not mask the workflow error

- **WHEN** the `persist-final-status` step fails
- **THEN** the error is logged with the `runId` and intended status
- **AND** the underlying workflow error is preserved in the DBOS workflow record

### Requirement: An insufficient-budget pause is suspended and made resumable

If the run suspends and synthesis did not fail, `collectAndComplete` MUST suspend
the run, and it MUST NOT fail it. The `workflow-suspension` capability gives the
causes of a suspension. For example, a host can suspend a run when an account has
no funds. Each suspension carries a reason from the host, and the harness does not
read that reason.

On the suspension branch, `collectAndComplete` MUST do these steps:

- Set the run row to `"canceled"`, with the reason of the host as the failure reason.
- Mark the analysis as suspended through the one function of the `workflow-suspension` capability, in a `DBOS.runStep` named `suspend-analysis`. The analysis row gets `status = "suspended_insufficient_funds"`.
- Close the running charge with the outcome `{ kind: "suspended", reason }`.
- Emit a `data-run-failed` part whose `reason` is the reason of the host.

The parent body SHALL then self-cancel via `DBOS.cancelWorkflow`
(to `CANCELLED`, never `ERROR`) so the paused parent stays DBOS-resumable.
`suspended_insufficient_funds` is a member of the run-status enum and gates the
active-run partial-unique index, so a paused run still counts as active and blocks
a duplicate launch. `suspended_insufficient_funds` is the name of the one
suspended state, for each reason.

Resuming a paused run after a top-up is a DEFERRED enhancement: no resume entry
point is wired, and the attempt-numbered step-name cache-busting a correct resume
requires was removed with the resume scaffolding. Until that lands, a paused run
stays `suspended_insufficient_funds` and is not re-driven.

#### Scenario: A child suspension suspends the analysis

- **GIVEN** a child step suspends with a reason of the host, and synthesis did not fail
- **WHEN** `collectAndComplete` runs
- **THEN** the run row reaches `"canceled"` with that reason, and the analysis row reaches `"suspended_insufficient_funds"`
- **AND** `collectAndComplete` closes the running charge with the outcome `{ kind: "suspended", reason }`, and the parent self-cancels to `CANCELLED`

#### Scenario: The harness does not read the reason

- **GIVEN** a provider whose suspend map gives the reason `"quota_reached"` for the status `429`
- **WHEN** a child step suspends with that reason
- **THEN** `collectAndComplete` takes the suspension branch, as for any other reason
- **AND** the run row, the charge close, and the `data-run-failed` part carry `"quota_reached"` with no change

### Requirement: A synthesis failure forces a failed terminal status

When the parent's `synthesizeFindings` step throws, the body MUST pass
`forceFailed: true` to `collectAndComplete`. `collectAndComplete` MUST then set the
status to `"failed"`, even when the run also suspended. A synthesis failure is
terminal, and it is never a resumable suspension. `collectAndComplete` MUST still
close the charge with the outcome `{ kind: "error" }`, and it MUST revoke the run
authorization. The body MUST then re-throw the synthesis error, thus the DBOS
workflow record goes to `ERROR`.

#### Scenario: Synthesis throws after steps completed

- **WHEN** `synthesizeFindings` throws and at least one step had completed
- **THEN** `collectAndComplete` sets `cortex_runs.status = "failed"` with the `synthesis-failed: …` error, closes the charge and revokes authorization, and the body re-throws so the workflow record is `ERROR`

#### Scenario: Synthesis failure beats a concurrent suspension

- **GIVEN** a child step suspended the run AND synthesis also threw
- **WHEN** `collectAndComplete` runs with `forceFailed: true`
- **THEN** the run is `"failed"` (not suspended) and the parent does not self-cancel for resumption

### Requirement: collectAndComplete is the single finalisation hook

`collectAndComplete` MUST be the only block that writes the terminal run-level
state. It MUST run on each terminal path:

- success
- a run with step failures, which drains the scheduler loop and usually ends `partial`
- the budget halt
- external cancel
- synthesis failure
- a refused charge open (see "The run opens its charge through a gate before a step starts")
- a suspension (see "An insufficient-budget pause is suspended and made resumable")

Within it the status write, charge close, and run-authorization revoke SHALL each be their own named
`DBOS.runStep`, and a failure of any one SHALL be logged without rolling back
the side effects that did succeed. There SHALL be NO separate `onError`-style
hook racing it; child step bodies SHALL NOT call `updateRunStatus` or any
run-fail helper directly.

`RunCharge.close` and `RunAuthorizer.revoke` are notices (see the `host-hooks`
capability). If a notice gives an `err`, `collectAndComplete` MUST log the reason
at the error level. The terminal status of the run MUST NOT change, and the other
steps of `collectAndComplete` MUST still run.

`collectAndComplete` MUST close the running charge with the outcome that matches
the terminal status:

- `{ kind: "ok" }` for `"completed"` and `"partial"`
- `{ kind: "error" }` for `"failed"`
- `{ kind: "canceled" }` for `"canceled"`, if the run did not suspend
- `{ kind: "suspended", reason }` for a suspension, with the reason of the host

On its genuinely-terminal paths (success, runs with step failures, external
cancel, synthesis failure) `collectAndComplete` SHALL additionally sweep the
run's still-`pending` step rows to `skipped` (stamping `completed_at`) in its
own named `DBOS.runStep`, so a finished run never advertises steps that read as
still waiting to start — including dependents that were never dispatched
because an upstream step failed or blocked. The sweep MUST NOT run on the
resumable suspension branch, because the resumed workflow uses those `pending`
rows. `collectAndComplete` MUST select that branch from the suspension itself,
not from the written run status. A suspension also writes `"canceled"`. A
sweep-step failure SHALL be logged
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

- **GIVEN** a suspended run with unstarted steps seeded `pending`
- **WHEN** `collectAndComplete` runs on the suspension branch
- **THEN** the `pending` rows are left untouched for the resumed workflow to execute
