# Tasks

## 1. Harness: the record of the run end and the NUL-free status write

- [x] 1.1 Add a small module under `src/execution/` that the body and the canceler import (design D3). It holds the event key of the recorded run end and the type of its value: `status` (a terminal run status), `error` (a string or `null`), `closed` (a boolean), and `revoked` (a boolean). It also holds a check of an unknown value against that type. The value comes from the engine as deserialized data, thus the canceler checks it before use. Make sure that `bun run typecheck` passes.
- [x] 1.2 Find the test of `updateRunStatus` under `src/state/`. Add a test: a write of `failed` with an error that holds a NUL character changes the row, and the stored error has no NUL. Run it before task 1.3 with the podman `DOCKER_HOST`. Make sure that it fails because Postgres rejects the NUL, and not for a different reason. Keep the failure output for the report.
- [x] 1.3 In `src/state/runs.ts`, make `updateRunStatus` remove each NUL from the error text with `stripNulCharacters` (`src/input-sanitization.ts`), as design D5 tells. Make sure that the test of task 1.2 passes.

## 2. Harness: the canceler repairs the row of a run whose body recorded its end

- [x] 2.1 In `src/execution/run-canceler.test.ts`, add tests for the scenarios of the `run-cancellation` delta. Give the fakes an injected read of the recorded run end. The default fake read gives `null`, thus the existing tests keep their meaning. These are the tests:
  - "A recorded run end repairs the row": the row holds `completed` with `completed_at` and no error, and the canceler does no emit, no close, and no revoke. Assert `outcome`, `finalStatus`, and the flags.
  - "A recorded run end keeps the error of the body": the row holds `failed` with the recorded error.
  - "A recorded run end emits nothing": a recorded `canceled` status, and the run emit receives no event.
  - "The flags show a failed charge close of the body": `closed` false and `revoked` true in the record.
  - "A repair write that changes nothing records no metric": the fake row leaves `running` before the repair write.
  - "A record with a wrong shape counts as a failed read".
  - "A failed read of the recorded run end writes nothing": the row stays `running`, no emit, no close, no revoke, the step rows settle, the flags are false, and `cancel` resolves.

  Run `bun test src/execution/run-canceler.test.ts` before task 2.2. Make sure that each new test fails for the reason under test: a wrong row, an emit, a close, a revoke, a metric, or a wrong flag. Keep the failure output for the report.
- [x] 2.2 In `src/execution/run-canceler.ts`, add the read of the recorded run end as an optional injected function of `RunCancelerDeps`, the same as `cancelWorkflows` (design D4). Name it for what it does. Its production default calls `DBOSClient.getEvent` with a zero timeout. Then:
  - Read the record after the engine cancel and the read of the cut steps, before the terminal write.
  - A present record: write its status and its error with `updateRunStatus`. Do no emit, no close, and no revoke. Record the run outcome metric with the recorded status only when the write changed the row, and record no step outcome metric. Take `converged.charge` from `closed` and `converged.mandate` from `revoked` for each result of the write.
  - An absent record: keep the current path.
  - A failed read, or a value that fails the check of task 1.1: do no terminal write and no act of the run end. Give the flags of a failed terminal write. Log the failure.
  - Keep the step settle on each path, and keep `outcome: "canceled"`. Update the file header so that it states the current rule.

  Make sure that `bun test src/execution/run-canceler.test.ts` passes.
- [x] 2.3 In `src/execution/dbos-workflow-purger.ts`, make one `DBOSClient` for each pool, and give it to the purger and to the production read of task 2.2. Keep the lazy creation, and keep the injected logger as the engine logger. Do not change the `WorkflowPurger` interface. Update the comment about one client, so that it states the current rule. Make sure that `bun run typecheck` passes.
- [x] 2.4 Add a real-engine test under `src/workflows/__tests__/dbos/`, with `setupDbosForTests`. It holds these cases:
  - A registered workflow calls `DBOS.setEvent` with the key of task 1.1. The production read of the canceler then gives the value.
  - The read for a workflow with no such event gives `null`, and it returns in less than 1 second.
  - The read for an id with no workflow row gives `null`.
  - A step with `retriesAllowed: true` and `maxAttempts: 2` sees `DBOS.stepStatus.currentAttempt` equal to `DBOS.stepStatus.maxAttempts` on its last attempt. Use a short `intervalSeconds`. The body of task 3.3 depends on this fact.

  Run the file with the podman `DOCKER_HOST`, and make sure that it passes.

## 3. Harness: the body retries the status write and records its run end

- [x] 3.1 In `src/workflows/execute-analysis.test.ts`, extend the DBOS mock. Make no change to the body in this task:
  - `DBOS.runStep` honors `retriesAllowed` and `maxAttempts` with no real wait. During each attempt, `DBOS.stepStatus` gives `currentAttempt` and `maxAttempts`, as DBOS does. When the last attempt throws, the mock throws that error.
  - A test can make a cancel land before a given attempt. The mock then throws a `DBOSWorkflowCancelledError` before that attempt.
  - `DBOS.setEvent` records each key and value into the fake state, in the same timeline as the run emit. A test can make it throw.

  Make sure that `bun test src/workflows/execute-analysis.test.ts` passes before task 3.2.
- [x] 3.2 In `src/workflows/execute-analysis.test.ts`, add tests for the new and changed scenarios of the `workflow-failure-lifecycle` delta:
  - "A transient failure of the status write retries": the first status `UPDATE` fails, and the second changes one row. The charge closes one time with `{ kind: "ok" }`, and the revoke runs one time. No `close-running-charge` or `revoke-run-auth` step runs, and one `run_completed` event comes.
  - "A failed commit after the emit does not emit again": the first `COMMIT` fails, and the next attempt changes the row. One `run_completed` event comes.
  - "A cancel stops the retries": the first `UPDATE` fails, and a cancel lands before the second attempt. The body rejects with the cancel, and no close, no revoke, and no `run_completed` event occur.
  - "A failed commit after the emit, then a cancel, keeps two run ends": the first `COMMIT` fails, and a cancel lands before the second attempt. The body rejects with the cancel, and no `setEvent` call occurs.
  - "A failed status write still closes the charge" and "A failed status write records the run end": each attempt fails. The close and the revoke run in their own steps, and one `run_completed` event comes. Then one `setEvent` call records the status, the error, `closed`, and `revoked`.
  - "A won or a refused write records no run end": no `setEvent` call.
  - "A failed record does not stop the body": `setEvent` throws a plain error. The body logs it, and `sweep-pending-steps` still runs.
  - "persist-final-status failure does not mask the workflow error": synthesis fails and each attempt of the status write fails. The body still rejects with the synthesis error.

  Update the existing failed-write tests so that each attempt fails. Run `bun test src/workflows/execute-analysis.test.ts` before task 3.3. Make sure that each new test fails for the reason under test: the missing retry, the missing record, or the extra emit. Keep the failure output for the report.
- [x] 3.3 In `src/workflows/execute-analysis.ts`, change `collectAndComplete` as design D1 and D3 tell:
  - `persist-final-status` runs with `retriesAllowed: true`, `maxAttempts: 5`, `intervalSeconds: 1`, and `backoffRate: 2`. Name the values as constants.
  - When the transaction gives an `err`, an attempt before the last throws, and it logs a warning. The last attempt logs `ledger write failed` with the `runId`, the status, and the cause. Then it returns `"failed"`. Read the attempt from `DBOS.stepStatus`.
  - The emit in the transaction fires only when `emittedInStep` is not set.
  - The body adds no `try` around the step.
  - Keep the results of the `close-running-charge` and `revoke-run-auth` steps.
  - After a failed write, the body calls `DBOS.setEvent` after the close, the revoke, and the emit. The key is the key of task 1.1. The value holds the status, the error, and the results of the close and the revoke. It sends a `DBOSWorkflowCancelledError` back with no change, and it logs each other error and continues.
  - Update the comments of the failed path and the header item 6 of the file, so that they state the current rule.

  Make sure that `bun test src/workflows/execute-analysis.test.ts` passes.

## 4. Verification

- [x] 4.1 Run `bun run format:file` on each changed file under `src/`. Then run `bun run typecheck` and `bun run lint`. Make sure that they pass.
- [x] 4.2 Run the full harness suite one time with `bun run test:full`. Make sure that it passes, or report each failure with its cause.
