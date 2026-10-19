# Tasks

## 1. Harness: the canceler closes and revokes only after a won write

- [x] 1.1 In `src/execution/run-canceler.test.ts`, add tests for the scenarios of the `run-cancellation` delta. Use the existing fakes. These are the scenarios:
  - "Concurrent completion wins the row": the fake conditional write changes no row. Assert that the recording charge receives no close, that the recording authorizer receives no revoke, and that `converged.charge` and `converged.mandate` are true. Keep the existing assertions of `finalStatus` and of the pending sweep.
  - "A failed terminal write closes no charge": the fake conditional write fails, and the row carries a mandate jti. Assert no close and no revoke, `converged.charge` false, `converged.mandate` false, the settled step rows, and a resolved `cancel`.

  Run `bun test src/execution/run-canceler.test.ts` before task 1.2. Make sure that each new test fails because of a close, a revoke, or a wrong flag, and not for a different reason. Keep the failure output for the report.
- [x] 1.2 In `src/execution/run-canceler.ts`, keep the result of `markRunCanceledIfActive` in three states: changed, refused, and failed (design D6). Close the charge and revoke the mandate only when the write changed the row. Set the `converged` flags as the delta requires. Keep the step settle on each path, and keep the phase order and the guards. Update the file header and the comments of the convergence phases, so that they state the current rule: the writer that wins the row owns the run end. Make sure that `bun test src/execution/run-canceler.test.ts` passes.

## 2. Harness: the body owns the run end only as the owner of the row

- [x] 2.1 In `src/workflows/execute-analysis.test.ts`, remove each fixture key `"SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id"` and its `{ attempt_count: 0 }` row. Give the fake pool a `connect()` that returns a client. The `query` of the client records into the same `queries` list, and it answers from the same `rowByText` map. It accepts a string text, for `BEGIN` and `COMMIT`, and a query config. The client also has a `release()`. Make sure that `bun test src/workflows/execute-analysis.test.ts` passes before task 2.2, with no change to the body.
- [x] 2.2 In `src/workflows/execute-analysis.test.ts`, add tests for the scenarios of the requirement "The body owns the end of the run only when its status write wins" in the `workflow-failure-lifecycle` delta. The fake pool answers an unmatched query with `rowCount: 0`. Thus a test of the won path must answer the run status write (`"UPDATE cortex_runs SET status = $1"`) with one changed row. Use `dbosState.throwErrorOnStep` to make `close-running-charge` throw a `DBOSWorkflowCancelledError` for the canceler path. Use `dbosState.resultOnStep` on `persist-final-status` for the replay from the cache. These are the tests:
  - A won write: the run emit receives one `run_completed` event. The emit occurs after the status `UPDATE` and before the `COMMIT`. Record the emit in the same timeline as the queries, for example as a marker entry, and assert its position there. The charge closes with `{ kind: "ok" }` and the revoke runs while `persist-final-status` runs, and no `close-running-charge` or `revoke-run-auth` step runs.
  - A write that the canceler refused: no `run_completed` event, no charge close, and no revoke.
  - A recovery after the own write landed (a refused write with no cancel): the charge closes in `close-running-charge`, the revoke runs in `revoke-run-auth`, and then one `run_completed` event comes with the `atMs` of the stubbed `DBOS.now()`.
  - A replay of a won step from the cache: one `run_completed` event with the same status, `atMs`, and `durationMs`, and no charge close and no revoke.
  - A failed status write: the charge closes, the revoke runs, and one `run_completed` event comes.

  The scenario "An engine cancel does not cut the acts of a won write" rests on the DBOS cancel check at the start of a step. The mocked DBOS cannot stop a step that runs. Thus the won-write test covers it: the close and the revoke run inside `persist-final-status`.

  Look at the existing tests that assert the run emit or the charge close on a terminal path, for example "the run emit collects run_started, step_completed, then run_completed on the success path with stub-sourced times". Where such a test means the normal won path, make the fake pool answer the status write with one changed row. Run `bun test src/workflows/execute-analysis.test.ts` before task 2.3. Make sure that each new test fails because of the current order of the run-end acts, and not for a different reason. Keep the failure output for the report.
- [x] 2.3 In `src/workflows/execute-analysis.ts`, change the end of `collectAndComplete` as the design tells (D2 to D5):
  - Remove the `run_completed` emit before `persist-final-status`. Keep the `DBOS.now()` terminal clock read before the step.
  - In `persist-final-status`, run `updateRunStatus` on the client of a `withTransaction` call. When the write changed the row, emit `run_completed` before the commit, and set a local flag. After the commit, record the metrics as now, close the charge, and revoke the authorization. The step returns whether the write won. A failed write logs as `ledgerStep` does now.
  - When the step reports a refused or failed write, run `close-running-charge` and then `revoke-run-auth`, each as its own step.
  - After that, emit `run_completed` when the flag is not set.
  - Keep `persist-synthesis-outcome`, `sweep-pending-steps`, `suspend-analysis`, and the UI stream parts after these acts, with no other change.
  - Replace the comment above the old emit and the comment above the UI stream parts. State the current rule. The body emits the run end only as the owner of the row, before the terminal row is visible. It emits outside the step when the step did not emit in this execution.

  Make sure that `bun test src/workflows/execute-analysis.test.ts` passes.

## 3. Verification

- [x] 3.1 Run `bun run format:file` on each changed file under `src/`. Then run `bun run typecheck` and `bun run lint`. Make sure that they pass.
- [x] 3.2 Run the full harness suite one time with `bun run test:full`. Make sure that it passes, or report each failure with its cause.
