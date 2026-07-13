# workflow-failure-lifecycle — delta

> Adds the resume half of the 402 budget-pause lifecycle. The pause itself
> already exists (a budget-exceeded run suspends to `suspended_insufficient_funds`
> with a `CANCELLED`, DBOS-resumable parent); this change wires the entry point
> that resumes it after a top-up.

## ADDED Requirements

### Requirement: A topped-up run resumes from its budget pause

A resume entry point SHALL, given the `run_id` of a `suspended_insufficient_funds`
run, resume the paused parent workflow so the analysis continues from where the
budget pause stopped it. The entry point SHALL verify the run is
`suspended_insufficient_funds` before acting (a run in any other status SHALL be
rejected, not resumed), obtain a never-before-seen step-name generation (so the
resumed body misses the cached `budget_exceeded` steps rather than replaying
them), `DBOS.resumeWorkflow` the parent, and re-drive each still-`CANCELLED`
child. On resume a fresh managed-root running charge SHALL be opened to replace
the one closed with `budget_exceeded` at the pause, and the analysis row SHALL
transition out of `suspended_insufficient_funds` back to `running`.

#### Scenario: Resume replays the paused parent after a top-up

- **GIVEN** a run in `suspended_insufficient_funds` whose parent is `CANCELLED` and whose budget has been topped up
- **WHEN** the resume entry point is invoked for that `run_id`
- **THEN** completed children return from the DBOS cache, the parent re-awaits and resumes the `CANCELLED` children under fresh step names, a new running charge is opened, and the analysis returns to `running`

#### Scenario: A non-suspended run is not resumed

- **GIVEN** a run whose status is not `suspended_insufficient_funds`
- **WHEN** the resume entry point is invoked for its `run_id`
- **THEN** it is rejected without calling `DBOS.resumeWorkflow`
