# harness-sandbox-agents — delta

> A blocker no longer fail-fasts the run. It is treated exactly like a step
> failure by the parent scheduler: only the blocked step's transitive dependents
> become unreachable; in-flight siblings and independent ready steps continue.

## MODIFIED Requirements

### Requirement: Step agents declare inability via report_blocker, not output inference

A step agent SHALL get a terminal `report_blocker({ reason })` tool whenever a
blocker cell is supplied; there SHALL be no `submit`/`done` tool, because a
step's deliverable is its persisted files. Calling `report_blocker` SHALL record
`{ kind: "blocker", reason }` into the per-run holder the workflow body reads
after `runAgent`. `blocked` SHALL be a distinct terminal step status — separate
from `failed` and `completed` — carrying the reason to the
`cortex_step_executions.blocked_reason` column, a `data-step-blocked` run-event
part, and the step return. The parent scheduler SHALL treat a blocker exactly
like a step failure: only the blocked step's transitive dependents become
unreachable, while in-flight siblings and independent ready steps continue
(see the harness-durable-runtime capability). The harness SHALL NOT infer
failure from output/artifact counts: a legitimately-empty step (no files, no
blocker, clean finish) SHALL stay `completed`.

#### Scenario: Blocker yields a distinct blocked status

- **GIVEN** a step agent that calls `report_blocker({ reason })` and stops
- **WHEN** the workflow body reads the blocker holder after the loop
- **THEN** the step SHALL terminate with status `blocked`, persisting the reason to `blocked_reason` and emitting a `data-step-blocked` part
- **AND** in-flight siblings SHALL NOT be cancelled; only the blocked step's transitive dependents are never dispatched

#### Scenario: Empty step is not auto-failed

- **GIVEN** a step that writes no artifacts, calls no blocker, and ends cleanly
- **WHEN** the step terminates
- **THEN** its status SHALL be `completed` (with `artifactCount: 0`), not failed or blocked
