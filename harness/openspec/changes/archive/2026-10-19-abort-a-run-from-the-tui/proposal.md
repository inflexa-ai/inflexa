# Settle the cut steps of a canceled run

## Why

The run canceler settles the run row, the pending step rows, the run charge, and the run mandate. But a step row that was `running` at the engine cancel stays `running` forever. The canceled child never writes its own terminal row, and the canceler sweeps only the `pending` rows.

The cli change of the same name (issue #250) lets a user abort a run from the TUI. Without this change, each user abort leaves a canceled run that shows a step that still runs.

## What Changes

- After the engine cancel, the canceler settles each step row of the run that is still `running`. The row becomes `canceled`, with `completed_at`, a duration from its `started_at`, and the reason `external_cancel`.
- The write is conditional on `status = 'running'`. Thus it never overwrites a terminal row that a child wrote first.
- The step phase of the canceler holds the pending sweep and the running settle. Each write has its own guard, thus one failure does not skip the other. `converged.steps` is true only when the two writes succeed.
- A new step-ledger helper does the running settle. `sweepPendingStepExecutions` does not change, because `collectAndComplete` uses it and its `skipped` status means "never started".

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `run-cancellation`: the convergence phase settles the running step rows to `canceled`, in addition to the pending sweep.
- `step-execution-tracking`: the query helpers get the conditional running-to-canceled settle.

## Impact

- `src/state/step-executions.ts`: a new helper for the running settle.
- `src/execution/run-canceler.ts`: the step phase calls it.
- Tests: `src/state/step-executions.test.ts` (Postgres) and `src/execution/run-canceler.test.ts` (in-memory pool fake).
- No change to the public interface: `CancelRunResult` keeps its shape, and the barrel does not change.
