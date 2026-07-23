# Proposal: synthesis-step-ledger-row

## Why

Run-level synthesis (`synthesize-findings`) is the longest single phase of a real run — 16m03s observed against 4–14 min per DAG step (issue #203) — and it is invisible to every ledger reader: the TUI sidebar reads 5/5 done with every glyph a checkmark, `inflexa run` narrates "5/5 step(s) complete" with a stale detail label, and the conversation agent's `inspect_run` has no row to report. A user watching any of those surfaces concludes the run has finished while the workflow keeps working (and, per #204, keeps `DBOS.shutdown()` blocked). A synthesis *failure* is equally invisible: the full 5/5 bar flips straight to a failed run with no indication of which phase died.

The step ledger (`cortex_step_executions`) is already the shared truth all three surfaces poll, and the parent workflow already seeds the full DAG as `pending` rows at run start precisely so `done/total` is honest from the first frame. Synthesis is the one phase of the run that does real, minutes-long agent work with no row — extending the same honesty to it fixes all three surfaces at once, with zero transport or UI change.

## What Changes

- `executeAnalysis` seeds a reserved `synthesis` row into `cortex_step_executions` alongside the DAG seed (only when synthesis is enabled), marks it `running` when the scheduler loop returns and synthesis actually starts, and stamps its terminal status from the synthesis outcome.
- The synthesis outcome maps onto the existing step-status vocabulary: `produced` → `completed`, `skipped_no_summaries` → `skipped`, `skipped_blocker` → `blocked` (with `blocked_reason`), a thrown synthesis → `failed` (with `error`). No new statuses, no new columns.
- A seeded-but-never-started synthesis row (run failed with zero completed steps, budget pause taken to a terminal cancel) is handled by the existing `sweepPendingStepExecutions` terminal sweep — `pending` → `skipped`, like any never-dispatched DAG step.
- `synthesis` joins the reserved step-id set in plan validation, so a plan step can never collide with the run-phase row (or with `runs/{runId}/synthesis.json`).
- Consumers change nothing: the TUI sidebar embed, `inflexa run` watch/`--status`, and `inspect_run` all read `queryStepsByRun` and pick the row up as-is. The run's step denominator becomes N+1 everywhere, honestly, from run start.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `step-execution-tracking`: the ledger admits one reserved run-phase row per run — `step_id = "synthesis"`, `agent_id = "run-synthesizer"`, `wave` after every DAG level — seeded, transitioned, and finalized by the parent workflow; the table is no longer exclusively DAG-step rows.
- `run-synthesis-outcome`: the classified synthesis outcome is additionally recorded on the run's `synthesis` step row (status + reason columns), not only on `cortex_runs`, so ledger readers see synthesis progress and its terminal shape without a new read path.
- `harness-workspace-tools`: the reserved step-id set grows `synthesis` (plan validation rejects it as a step id).

## Impact

- **Code**: `harness/src/workflows/execute-analysis.ts` (seed + mark-running + terminal stamp, mirroring the exact `synthesisEnabled && completed.size > 0` gate), `harness/src/schemas/validate-plan.ts` (reserved id), tests for both. No schema migration — the row uses existing columns and statuses.
- **Consumers (no code change required)**: `cli/src/tui/hooks/sidebar_live.ts`, `cli/src/modules/harness/run.ts`, `harness/src/tools/research/inspect-run.ts` — all read `queryStepsByRun` and render the new row through their existing status mappings. Copy that counts "steps" (e.g. `inflexa run`'s "N step(s)") now includes the synthesis row.
- **Non-impact**: the scheduler dispatches from `input.steps`, never from ledger rows, so the reserved row cannot affect scheduling, recovery, or replay. The budget-pause path preserves `pending` rows for resume; the synthesis row participates correctly by construction.
- **Related, out of scope**: consuming the run-event stream for live activity labels (issue #203's "full fidelity" direction) and the #204 shutdown bound.
