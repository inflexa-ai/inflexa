# Own the run end after a failed status write

## Why

A failed status write of `persist-final-status` leaves a run end with no owner. The body still closes the charge, revokes the authorization, and emits `run_completed`, but the row stays `running`. A later abort then wins the row in the run canceler. The canceler records a second run end, and it closes the charge and revokes a second time. The change `bind-the-run-end-to-the-row-owner` named this gap in its risks and did not fix it.

## What Changes

- The status write of `persist-final-status` retries a failed write with backoff, for about 15 seconds. Thus a transient database error rarely reaches the failed path.
- The status write removes each NUL character from the error text. Postgres rejects a NUL in text, thus the write cannot fail for its own values.
- The body keeps the run end after a failed write. It closes the charge, revokes the authorization, and emits `run_completed`, as now. Thus the charge and the mandate do not stay open.
- After these acts, the body records its run end in the durability engine. The record is a workflow event with the status, the error, and the results of the close and the revoke.
- Before its terminal write, the run canceler reads that record. When the record is present, the canceler writes its status and its error to the row. Then the canceler does no act of the run end: it emits nothing, closes no charge, and revokes no mandate.
- When the read of the record fails, the canceler does no terminal write and no act of the run end. The row stays `running`, thus a second cancel converges the run.
- The writer that wins the row still owns the run end in each other case.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-failure-lifecycle`: the status write retries with backoff, and it removes NUL from the error text. After a failed write, the body records its run end in the engine. The requirement "The body owns the end of the run only when its status write wins" gets a name that matches the failed-write path.
- `run-cancellation`: before its terminal write, the canceler reads the run end that the body recorded. A recorded run end makes the terminal write a repair with the status of the body. The canceler then does no emit, no charge close, and no revoke.

## Impact

- `src/workflows/execute-analysis.ts`: `persist-final-status` and the failed-write path of `collectAndComplete`.
- `src/state/runs.ts`: `updateRunStatus` removes NUL from the error text.
- `src/execution/run-canceler.ts`: a read of the recorded run end between the engine cancel and the terminal write, and the repair write.
- `src/execution/dbos-workflow-purger.ts`: the canceler and the purger share one `DBOSClient` for each pool.
- A module that the body and the canceler share holds the event key and the type of the recorded run end.
- The test files: `src/workflows/execute-analysis.test.ts`, `src/execution/run-canceler.test.ts`, the test of `updateRunStatus`, and a real-engine test under `src/workflows/__tests__/dbos/`.
- `RunCancelerDeps`, which `src/index.ts` exports, gets one more optional member. Existing callers do not change. `CancelRunResult`, `RunCharge`, `RunAuthorizer`, `WorkflowPurger`, and `RunProvenanceEvent` keep their shapes. No change in the cli or in prov-kernel.
- The terminal block of the body gets one more durable operation on the failed path. A workflow that a recovery replays across this change can meet a different operation at that position.
