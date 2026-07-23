## ADDED Requirements

### Requirement: The run's synthesis phase has a reserved ledger row

`cortex_step_executions` SHALL carry at most one reserved **run-phase** row per
run for run-level synthesis, identified by `step_id = "synthesis"` and
`agent_id = "run-synthesizer"`, with `wave` strictly greater than every DAG
step's topological level so ledger-ordered readers (`queryStepsByRun`'s
`ORDER BY wave, started_at NULLS LAST, step_id`) render it after every DAG
step. The row SHALL use only the existing columns and status vocabulary — no
schema change distinguishes a run-phase row from a DAG-step row; the reserved
identity is the distinction.

The parent workflow SHALL seed the row as `pending` in the same seed operation
that seeds the DAG rows, and ONLY when synthesis is enabled for the run
(`synthesisEnabled`): a run configured without synthesis reports no synthesis
row at all, so its step count stays the plan's step count. From the seed
onward, `done/total` derived from the ledger is honest — the denominator
includes synthesis from the first frame rather than growing when synthesis
starts.

#### Scenario: Seeded pending with the DAG when synthesis is enabled

- **GIVEN** `executeAnalysis` starts a 5-step plan with synthesis enabled
- **WHEN** the step ledger is seeded at run start
- **THEN** `queryStepsByRun` returns 6 rows — the 5 DAG steps plus a `pending`
  `synthesis` row with `agent_id = "run-synthesizer"` — and the `synthesis` row
  orders last

#### Scenario: Not seeded when synthesis is disabled

- **GIVEN** `executeAnalysis` starts with `synthesisEnabled: false`
- **WHEN** the step ledger is seeded at run start
- **THEN** no `synthesis` row exists for the run and the ledger's row count
  equals the plan's step count

#### Scenario: Replayed seed cannot reset an advanced synthesis row

- **GIVEN** a recovery replay re-executes the seed against a `synthesis` row a
  prior execution already advanced past `pending`
- **WHEN** the seed runs
- **THEN** the row's status is unchanged (the seed is conflict-do-nothing,
  idempotent and monotone)

### Requirement: The synthesis row transitions with the phase it describes

The parent workflow SHALL mark the `synthesis` row `running` (stamping
`started_at`) immediately before the `synthesize-findings` step executes, and
SHALL stamp its terminal status (with `completed_at` and `duration_ms`)
immediately after that step settles — on the success path and on the failure
path — **before** the run row's own terminal status is written, so no reader
observes a terminal run beside a still-`running` synthesis row. The
mark-running transition SHALL occur only when the run's synthesis gate passes
(synthesis enabled AND at least one completed step); a seeded row whose gate
never passes stays `pending` and is finalized by the existing terminal sweep
(`pending` → `skipped`), like any never-dispatched DAG step.

Failures writing the mark-running or terminal transition SHALL log and continue
(the finalisation discipline of the run's other terminal ledger writes): a
progress row must never fail an otherwise-healthy run.

Workflow cancellation SHALL NOT be classified as a synthesis outcome: a
`DBOSWorkflowCancelledError` raised while synthesis is in flight re-propagates
unchanged (the sandbox-step rule), leaving the row untouched — on that path the
run row itself never reaches a terminal status either, so the pair stays
consistent, and the CANCELLED-workflow-over-`running`-ledger shape is the
pre-existing wedge class `inflexa run` already detects.

#### Scenario: Cancellation mid-synthesis is not a synthesis failure

- **GIVEN** the workflow is cancelled while `synthesize-findings` is in flight
- **WHEN** the cancellation error reaches the synthesis error handling
- **THEN** it re-propagates unchanged — the `synthesis` row is not stamped
  `failed`, no synthesis outcome is recorded on `cortex_runs`, and both rows
  still read `running` under the CANCELLED workflow

#### Scenario: Running while synthesis works

- **GIVEN** a run whose last DAG step just completed and whose synthesis gate
  passes
- **WHEN** `synthesize-findings` is executing
- **THEN** `queryStepsByRun` reports the `synthesis` row `running` with
  `started_at` set, while the run row is still `running`

#### Scenario: Terminal before the run row

- **WHEN** synthesis settles (any outcome)
- **THEN** the `synthesis` row reaches its terminal status before
  `cortex_runs.status` leaves `running`

#### Scenario: Gate never passes — swept to skipped

- **GIVEN** synthesis is enabled but the run completes zero steps
- **WHEN** the run finalizes
- **THEN** the `synthesis` row is `skipped` (via the terminal sweep), never
  `running`
