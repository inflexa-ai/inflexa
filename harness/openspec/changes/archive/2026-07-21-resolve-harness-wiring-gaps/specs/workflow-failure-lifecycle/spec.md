# workflow-failure-lifecycle — delta

> Decision 4 resolved (retire the resume scaffolding): the 402-pause is retained
> — a budget-exceeded run still suspends to `suspended_insufficient_funds` and
> the parent self-cancels to `CANCELLED` (not `ERROR`), which keeps the paused
> parent DBOS-resumable for a FUTURE resume entry point. What is removed is the
> resume-counter cache-busting the never-built entry point required: the
> "Resume replays the paused parent" scenario referenced the now-deleted
> attempt-numbered `open-running-charge:${attempt}` step name, so it is dropped.
> Resuming a paused run is a deferred enhancement, not a currently-wired path.

## MODIFIED Requirements

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
