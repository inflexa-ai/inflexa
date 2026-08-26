# harness-sandbox-agents Delta

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
failure from output/artifact counts for a step that finished on its own
initiative: a legitimately-empty step (no files, no blocker, clean finish
before the iteration cap) SHALL stay `completed`.

The exception is narrow. If the loop hits its iteration cap, the artifact
manifest is empty, and no blocker exists, the step MUST terminate `blocked`.
The reason MUST be deterministic, and it MUST name the cap and the empty
manifest. A capped-out step with artifacts stays `completed`, because partial
output is real output.

#### Scenario: Blocker yields a distinct blocked status

- **GIVEN** a step agent that calls `report_blocker({ reason })` and stops
- **WHEN** the workflow body reads the blocker holder after the loop
- **THEN** the step SHALL terminate with status `blocked`, persisting the reason to `blocked_reason` and emitting a `data-step-blocked` part
- **AND** in-flight siblings SHALL NOT be cancelled; only the blocked step's transitive dependents are never dispatched

#### Scenario: Empty step is not auto-failed

- **GIVEN** a step that writes no artifacts, calls no blocker, and ends cleanly before its iteration cap
- **WHEN** the step terminates
- **THEN** its status SHALL be `completed` (with `artifactCount: 0`), not failed or blocked

#### Scenario: Capped-out step with no deliverables is blocked

- **GIVEN** a step whose loop hits the iteration cap, with an empty artifact manifest and no blocker
- **WHEN** the workflow body reads the manifest after the loop
- **THEN** the step MUST terminate `blocked`, with a deterministic reason in `blocked_reason` and a `data-step-blocked` part
- **AND** the transitive dependents of the step are never dispatched

#### Scenario: Capped-out step with artifacts stays completed

- **GIVEN** a step whose loop hits the iteration cap, with a non-empty artifact manifest
- **WHEN** the step terminates
- **THEN** its status SHALL be `completed`, with `hitMaxSteps` persisted
