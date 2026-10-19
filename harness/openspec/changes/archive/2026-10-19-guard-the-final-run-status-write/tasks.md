# Tasks

## 1. Harness: the first terminal write of a run row wins

- [x] 1.1 In `src/state/runs.test.ts`, add Postgres tests for the `updateRunStatus` scenarios of the `run-state-persistence` delta. These are the scenarios:
  - a `running` row changes to `suspended_insufficient_funds`, and the call returns `true`
  - a row that `markRunCanceledIfActive` changed to `canceled` keeps `canceled`, its `completed_at`, and `external_cancel` after a write of `completed`, and the call returns `false`
  - a `completed` row keeps its status, its `completed_at`, and its error after a write of `failed`, and the call returns `false`
  - a write for an unknown `runId` returns `false`.

  Run `bun run test:full src/state/runs.test.ts` before task 1.2. Make sure that the new tests fail because the row changes or the result is not a boolean, and not for a different reason. Keep the failure output for the report.
- [x] 1.2 In `src/state/runs.ts`, add `AND status = 'running'` to the `UPDATE` of `updateRunStatus`, and return `(result.rowCount ?? 0) > 0`. The result type becomes `ResultAsync<boolean, DbError>`. Keep the `running` member of the status parameter. Give the function a short document comment that states the first-write-wins rule. Make sure that `bun run test:full src/state/runs.test.ts` passes.
- [x] 1.3 In the document comment of `markRunCanceledIfActive`, remove the clause about a fall back to `updateRunStatus`. That clause says that `updateRunStatus` clobbers a terminal status, and task 1.2 makes it false. Make sure that the comment states only the current behavior.
- [x] 1.4 In `src/execution/run-canceler.ts`, correct the inline comment above the `transitioned` block. It says that the terminal step of the workflow never runs after a cancel. A terminal step that started before the cancel can still write, but its write is conditional too. The file header says that `collectAndComplete` is unreachable on an external cancel. Correct that sentence in the same way. Change no code in this file. Make sure that `bun test src/execution/run-canceler.test.ts` passes.

## 2. Harness: only a won write records the outcome metrics

- [x] 2.1 In `src/workflows/execute-analysis.test.ts`, add a test for the scenario "A late status write keeps the cancel of the canceler". Make the fake pool answer the run status write with `rowCount: 0`. Give the ledger read at least one failed or canceled step row with `completed_at: null`, so that the step-metric assertion is not empty. Assert that the body records no `cortex.run.completed` sum and no `cortex.step.completed` sum. In the test "persist-final-status counts the run once …", make the fake pool answer the run status write with one changed row. Use a prefix that matches only the status write, not the synthesis-outcome write. Run `bun test src/workflows/execute-analysis.test.ts` before task 2.2. Make sure that the new test fails because the metrics are recorded. Keep the failure output for the report.
- [x] 2.2 In `src/workflows/execute-analysis.ts`, in the `persist-final-status` step of `collectAndComplete`, return the result before the metrics when the write gives `ok(false)`. Keep the metrics for `ok(true)`, and keep the error path. Update the comment of the step: the outcome metrics ride the write that changed the row. A refused write means that an earlier write already set a terminal status. That write came from the run canceler, or from an earlier run of this step before a crash. Make sure that `bun test src/workflows/execute-analysis.test.ts` passes.

## 3. Cli: the dev run test fake gives the new result type

- [x] 3.1 In `cli/src/modules/harness/dev/run.test.ts`, make the `updateRunStatus` fake give `okAsync(true)`. Run `bun run build` in `harness/`, then `bun run typecheck` and `bun test src/modules/harness/dev/run.test.ts` in `cli/`. Make sure that they pass.

## 4. Verification

- [x] 4.1 Run `bun run format:file` on each changed file under `harness/src/` and `cli/src/`. Then run `bun run typecheck` and `bun run lint` in `harness/`. Make sure that they pass.
- [x] 4.2 Run the full harness suite one time with `bun run test:full` in `harness/`. Make sure that it passes, or report each failure with its cause.
