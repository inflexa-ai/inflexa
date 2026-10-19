# Guard the final run status write

## Why

The final status write of the run body can overwrite a run that the run canceler already canceled. `updateRunStatus` changes the `cortex_runs` row with no status condition. A `persist-final-status` step that started before the engine cancel can write after `markRunCanceledIfActive`. The row then says `completed`, but the canceler reports `canceled`, closes the charge as `canceled`, and records a `canceled` run end in the provenance document. The same step also records the outcome metrics of the run, thus the run counts two times.

## What Changes

- `updateRunStatus` changes the run row only when the status of the row is `running`. Thus the first terminal write of a run wins, and a later write does not change the row.
- `updateRunStatus` reports if it changed the row. Its result changes from `ResultAsync<void, DbError>` to `ResultAsync<boolean, DbError>`, the same as `markRunCanceledIfActive`.
- The `persist-final-status` step of `collectAndComplete` records the run outcome metric and the residual step outcome metrics only when its write changes the row. When the canceler wrote the row first, only the canceler records the outcome.
- The body continues after a refused write with no other change. After an engine cancel, the next step of the body stops the body.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `run-state-persistence`: `updateRunStatus` changes only a `running` row, and it reports if it changed the row.
- `workflow-failure-lifecycle`: the status write of `collectAndComplete` does not overwrite a terminal row. Only a write that changes the row records the outcome metrics.

## Impact

- `src/state/runs.ts`: the status condition and the result of `updateRunStatus`.
- `src/workflows/execute-analysis.ts`: the `persist-final-status` step uses the result of the write for the metrics.
- Comment corrections only: the document comment of `markRunCanceledIfActive` in `src/state/runs.ts`, and the comments of `src/execution/run-canceler.ts` that say the terminal step of the body cannot write after a cancel.
- Tests: `src/state/runs.test.ts` (Postgres), and `src/workflows/execute-analysis.test.ts` (fake pool).
- The public barrel exports `updateRunStatus`, thus its result type changes for an embedder. The test fake of the injected status write of the cli dev run (`cli/src/modules/harness/dev/run.test.ts`) gives `okAsync(undefined)` for this function, and it must give a boolean. The cli code ignores the value.
- The pre-workflow writers of `execute_analysis` and of the cli dev run write a row that they reserved as `running`, thus their behavior does not change.
