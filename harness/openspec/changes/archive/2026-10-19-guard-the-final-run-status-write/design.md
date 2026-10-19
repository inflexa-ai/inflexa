# Design

## Context

Refer to `proposal.md` for the race. These facts of the current code shape the approach:

- Each non-test caller of `updateRunStatus` writes a row that is still `running`:
  - `collectAndComplete` writes one time, in `persist-final-status` (`src/workflows/execute-analysis.ts`).
  - The refusal and launch-failure paths of `execute_analysis` write a row that they reserved some seconds before (`src/tools/execute-analysis.ts`).
  - The cli dev run writes `failed` through an injected function in the same two cases (`cli/src/modules/harness/dev/run.ts`).
- No code writes `running` to a run row again. The resume of a suspended run is deferred, and no resume entry point exists (`workflow-failure-lifecycle`).
- Each other writer of the run status already has a status condition, and it reports a change: `markRunCanceledIfActive`, `promoteFailedToPartial`, and `reconcileOrphanedRuns`.
- DBOS lets a step that started before a cancel run to its end. The next step of a canceled workflow throws `DBOSWorkflowCancelledError`.
- `src/lib/metrics.ts` defines `cortex.run.completed` as one count for each run that reached a terminal status. The canceler records its count only when its conditional write wins.

## Goals / Non-Goals

**Goals:**

- For the status writes through `updateRunStatus` and `markRunCanceledIfActive`, the first terminal write of a run row wins. A later write of the body, of the canceler, or of a pre-workflow path does not change the row.
- When the body and the canceler race, the run counts one time in the outcome metrics, from the writer that won the row. The pre-workflow writers record no outcome metric, and this change does not change that.

**Non-Goals:**

- The `run_completed` provenance emit of the body stays before the status write. That order lets the cli flush the end of the run before its poll sees a terminal row. Thus a canceler that wins the race still leaves the earlier `run_completed` of the body in the provenance document. A separate change must decide that order.
- The charge close and the mandate revoke of the canceler do not change. The canceler closes the charge as `canceled` also when its own write is refused.
- No resume path. A future resume must write `running` with its own transition.

## Decisions

### D1: The guard goes into `updateRunStatus`

The `UPDATE` of `updateRunStatus` gets the condition `AND status = 'running'`. Thus each caller gets the rule "the first terminal write wins".

Alternative: a new conditional helper only for `persist-final-status`, with `updateRunStatus` unchanged. The pre-workflow writers would then stay without a guard, and a later writer could again overwrite a terminal row. This design does not show that a pre-workflow write can race a cancel today. Two functions would also do the same write. Thus this design rejects the alternative.

The status parameter keeps `running` in its type, because the cli binds the function with the full `RunStatus` type. A write of `running` matches a `running` row. It returns `true`, and it sets `completed_at` and `error` to null. No caller writes `running`, and this change adds no rule for that value.

### D2: `updateRunStatus` reports a change

The result changes from `ResultAsync<void, DbError>` to `ResultAsync<boolean, DbError>`. The value is `rowCount > 0`. This is the same shape as `markRunCanceledIfActive` and `promoteFailedToPartial`.

`persist-final-status` reads the value. When the value is `false`, the step skips the residual step metrics and the run metric, and it returns the ok result. When the value is `true`, the step records the metrics as it does now. An error result stays an error result of the step, and `ledgerStep` logs it.

Alternative: keep `void` and record the metrics on each write. Then a lost race counts the run two times: `canceled` from the canceler and the status of the body from the step. Thus this design rejects the alternative.

The callers in `src/tools/execute-analysis.ts` ignore the value. Their `.match` handlers do not read it. The cli code also ignores it. The cli test fake of `updateRunStatus` gives `okAsync(undefined)`, and it must give `okAsync(true)` for the cli typecheck.

### D3: The body continues after a refused write

A refused write does not stop the body. Two cases give a refused write:

- The canceler won the row. The engine cancel came first, thus the next step of the body throws `DBOSWorkflowCancelledError`, and the body stops.
- A recovery runs again a `persist-final-status` step whose write landed before a crash and whose checkpoint did not. The row has the status of the body already. The body must then still close the charge and revoke the mandate.

Thus an early return is wrong for the second case and is not necessary for the first case.

## Risks / Trade-offs

- [A recovery runs a step again after its write landed] → The second run records no metrics. The first process recorded them or lost them on the crash. This is the same loss as before this change.
- [An embedder calls `updateRunStatus` on a terminal row to change it] → The call now changes nothing and returns `false`. No caller in the harness or the cli does this. The tests that seed a terminal status write a row that `insertRun` made `running`.
- [The cli dev run test fake has the old result type] → The fake gives `okAsync(true)`. The cli typecheck resolves the harness through its `dist`, thus a harness build comes before the cli typecheck.
