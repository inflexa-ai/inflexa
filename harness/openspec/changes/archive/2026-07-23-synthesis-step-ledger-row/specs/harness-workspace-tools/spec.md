## ADDED Requirements

### Requirement: The run-phase id synthesis is rejected as a step id

Plan validation SHALL reject any step whose id equals `synthesis`,
case-insensitively, alongside the reserved artifact-subdir names: the id is
reserved for the run-phase ledger row in `cortex_step_executions`
(`PRIMARY KEY (run_id, step_id)` would collide), and a step directory
`runs/{runId}/synthesis/` would additionally sit beside the run-level
`runs/{runId}/synthesis.json`. The validation error SHALL name the reserved-id
rule so the planner gets actionable feedback.

#### Scenario: A synthesis step id fails plan validation

- **GIVEN** a plan with a step whose id is `synthesis` (or `SYNTHESIS`)
- **WHEN** the plan is validated
- **THEN** validation SHALL fail with an error naming the reserved-id rule, and
  the plan SHALL NOT execute
