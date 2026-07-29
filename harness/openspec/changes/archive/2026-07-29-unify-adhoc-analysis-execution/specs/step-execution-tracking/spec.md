## MODIFIED Requirements

### Requirement: The run's synthesis phase has a reserved ledger row

`cortex_step_executions` SHALL carry at most one reserved **run-phase** row per
run for run-level synthesis, identified by `step_id = "synthesis"` and
`agent_id = "run-synthesizer"`, with `wave` strictly greater than every DAG
step's topological level so ledger-ordered readers (`queryStepsByRun`'s
`ORDER BY wave, started_at NULLS LAST, step_id`) render it after every DAG
step. The row SHALL use only the existing columns and status vocabulary — no
schema change distinguishes a run-phase row from a DAG-step row; the reserved
identity is the distinction.

The parent workflow SHALL resolve synthesis enablement from
`ExecuteAnalysisInput.synthesisEnabled`, defaulting an absent value to `true`
for workflows persisted before the field existed. It SHALL seed the row as
`pending` in the same seed operation that seeds the DAG rows ONLY when synthesis
is enabled for that run. A run whose input disables synthesis reports no
synthesis row at all, so its step count stays the plan's step count. From the
seed onward, `done/total` derived from the ledger is honest — the denominator
includes synthesis from the first frame rather than growing when synthesis
starts.

#### Scenario: Seeded pending with the DAG when synthesis is enabled

- **GIVEN** `executeAnalysis` starts a 5-step plan with `synthesisEnabled: true`
- **WHEN** the step ledger is seeded at run start
- **THEN** `queryStepsByRun` returns 6 rows — the 5 DAG steps plus a `pending` `synthesis` row with `agent_id = "run-synthesizer"` — and the `synthesis` row orders last

#### Scenario: Not seeded when synthesis is disabled

- **GIVEN** `executeAnalysis` starts with `synthesisEnabled: false`
- **WHEN** the step ledger is seeded at run start
- **THEN** no `synthesis` row exists for the run and the ledger's row count equals the plan's step count

#### Scenario: Legacy input preserves synthesis

- **GIVEN** a recovered `executeAnalysis` input persisted before `synthesisEnabled` existed
- **WHEN** the parent resolves synthesis behavior
- **THEN** it treats synthesis as enabled

#### Scenario: Replayed seed cannot reset an advanced synthesis row

- **GIVEN** a recovery replay re-executes the seed against a `synthesis` row a prior execution already advanced past `pending`
- **WHEN** the seed runs
- **THEN** the row's status is unchanged (the seed is conflict-do-nothing, idempotent and monotone)
