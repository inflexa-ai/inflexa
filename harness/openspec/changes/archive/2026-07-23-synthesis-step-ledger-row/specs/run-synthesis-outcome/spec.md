## ADDED Requirements

### Requirement: The classified outcome is recorded on the synthesis step row

The classified synthesis outcome SHALL be recorded as the terminal status of
the run's reserved `synthesis` row in `cortex_step_executions` (see
step-execution-tracking), in addition to the `cortex_runs` synthesis columns,
mapped onto the existing step-status vocabulary:

- `produced` → `completed`
- `skipped_no_summaries` → `skipped`
- `skipped_blocker` → `blocked`, with `blocked_reason` carrying the blocker
  reason — `blocked` (not `skipped`) because the synthesizer's `report_blocker`
  is precisely the ledger's "agent honestly declared it could not produce its
  deliverable", and flattening it to `skipped` would erase both the reason and
  the distinction from "nothing to synthesize"
- a thrown synthesis → `failed`, with `error` carrying the same reason string
  persisted to `cortex_runs.synthesis_reason` (no new information exposure
  beyond the run row's existing treatment)

This gives every ledger reader (TUI sidebar, `inflexa run`, `inspect_run`) the
synthesis phase and its terminal shape through the read path they already use;
`cortex_runs.synthesis_status` remains the authority consumers key on for
whether `synthesis.json` exists.

#### Scenario: Produced synthesis completes the row

- **WHEN** the synthesizer submits a valid synthesis
- **THEN** the `synthesis` row is `completed` and `cortex_runs.synthesis_status`
  is `produced`

#### Scenario: Blocker records blocked with its reason

- **GIVEN** the synthesizer called `report_blocker` with a reason
- **WHEN** the run finalizes
- **THEN** the `synthesis` row is `blocked` with `blocked_reason` = the blocker
  reason, and the run itself still resolves normally (a blocker is non-fatal)

#### Scenario: Thrown synthesis fails the row before the run

- **GIVEN** synthesis throws
- **WHEN** the failure is recorded
- **THEN** the `synthesis` row is `failed` with `error` = the synthesis failure
  reason, stamped before the run row reports `failed` — a reader watching the
  ledger sees which phase died

### Requirement: inspect_run surfaces the synthesis row without a per-step summary path

`inspect_run` SHALL include the run-phase `synthesis` row in a run's step list
(so a consumer sees the phase and its status) but SHALL NOT emit a per-step
`summaryPath` for it: the synthesis phase is not a sandbox step and writes no
`runs/{runId}/synthesis/output/summary.md`. Its product is the run-level
`synthesis.json`, which `inspect_run` already surfaces as the run's
`synthesisPath` (gated on the produced outcome). Emitting a per-step path for
the synthesis row would point a consumer at a file that never exists — the same
stale-path failure the `synthesisPath` gating exists to prevent.

#### Scenario: The synthesis step row carries no summaryPath

- **GIVEN** a run whose `synthesis` row is `completed` alongside a completed DAG step
- **WHEN** `inspect_run` formats the run's steps
- **THEN** the DAG step carries `summaryPath = runs/{runId}/{stepId}/output/summary.md`, the `synthesis` row carries no `summaryPath`, and the run's `synthesisPath` is `runs/{runId}/synthesis.json`
