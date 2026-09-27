## MODIFIED Requirements

### Requirement: There is no boot-time orphan sweep

`initCortexState()` SHALL NOT bulk-transition `running` runs or steps to
`failed` on startup. It SHALL apply the pending schema migrations and SHALL do nothing more
to run state. Recovery of in-flight runs is owned by DBOS workflow recovery under
each host's stable `executorId`; the workflow body owns the terminal transition.
A boot-time bulk fail would race that recovery and wrongly mark sibling-replica
runs as failed.

#### Scenario: Restart leaves running rows untouched

- **GIVEN** `cortex_runs` has rows with `status = 'running'` from a previous process
- **WHEN** `initCortexState()` executes on boot
- **THEN** those rows remain `'running'` (no bulk UPDATE is issued)
- **AND** DBOS recovery reclaims their workflows under the stable `executorId`

#### Scenario: Init touches only schema

- **WHEN** `initCortexState()` runs
- **THEN** it applies only the pending schema migrations and issues no `UPDATE … WHERE status='running'` against `cortex_runs` or `cortex_step_executions`
