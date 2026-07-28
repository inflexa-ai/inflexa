## ADDED Requirements

### Requirement: Plan-less runs have no synthesis phase or synthesis path

A run with `plan_id IS NULL` (an adhoc run) SHALL NOT run a synthesis phase, SHALL NOT reserve a synthesis ledger row, and SHALL leave its `synthesis_status` unset (NULL). `inspect_run` SHALL report `synthesisPath = null` for such a run regardless of its `status`, consistent with the existing rule that a `synthesisPath` is advertised only when `synthesis_status = "produced"`. A plan-less run's deliverable is its single `adhoc` step's `summary.md`, surfaced via that step's `summaryPath`.

#### Scenario: Completed adhoc run advertises no synthesis path

- **GIVEN** a completed run with `plan_id = NULL` and `synthesis_status = NULL`
- **WHEN** `inspect_run` formats that run
- **THEN** `synthesisPath` is `null` and the run's `adhoc` step carries a `summaryPath`

#### Scenario: Adhoc run reserves no synthesis row

- **GIVEN** an adhoc run is seeded at start
- **WHEN** its step-execution rows are queried
- **THEN** exactly one row exists (`step_id = "adhoc"`) and no reserved `synthesis` phase row is present
