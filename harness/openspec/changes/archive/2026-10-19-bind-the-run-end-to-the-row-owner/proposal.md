# Bind the run end to the owner of the run row

## Why

The run body and the run canceler race at the end of a run. Each one does a conditional terminal write of the `cortex_runs` row, and the first write wins. But the other acts of the run end do not obey the winner:

- The body emits `run_completed` with its own status before its status write. When the canceler wins the row after that emit, the canceler emits a second `run_completed` with `canceled`. The signed provenance document then holds two run ends for one run.
- The canceler closes the charge as `canceled` and revokes the mandate also when its write is refused. When the body won the row, the engine cancel can stop the body before its own charge close and revoke. The charge then closes as `canceled` for a row that says `completed`. When the body finished first, the charge closes two times.

The two findings have one root cause. The writer that wins the row does not own the run-end acts. The change `guard-the-final-run-status-write` named both as non-goals and left them to a separate change.

## What Changes

- The writer that wins the conditional terminal write of a run row owns each act of the run end: the `run_completed` emit, the charge close, and the mandate revoke. The other writer does none of these acts.
- The body emits `run_completed` only when its status write changes the row, or when it owns the row after a recovery. The emit stays before another reader can see the terminal row. Thus the cli flush still captures the run end before its poll sees the row.
- The body closes the charge and revokes the mandate in the same durable step as its won status write. An engine cancel cannot stop a step that started, thus a cancel can no longer cut the body between its won write and these acts.
- After a refused or failed status write, the body closes the charge and revokes the mandate in their own steps. Then it emits the run end. A recovery that runs the status step again after its own write landed thus still completes the run end. When the canceler won the row, its engine cancel came first, thus the first of these steps stops the body.
- The canceler closes the charge and revokes the mandate only when its write changes the row. A refused write leaves both to the body that won the row.
- Fixture cleanup: the fixture keys of `src/workflows/execute-analysis.test.ts` that answer a query with `workflow_id` and `attempt_count` go away. No query of the body has that text, thus the keys never match.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-failure-lifecycle`: the status step of `collectAndComplete` owns the run end when its write wins. The status write, the charge close, and the revoke share one step on the won path. The body emits `run_completed` only as the owner of the row.
- `run-cancellation`: the charge close and the revoke of the canceler ride its won terminal write, the same as its emits. The `converged` flags state this.

## Impact

- `src/workflows/execute-analysis.ts`: the end of `collectAndComplete`.
- `src/execution/run-canceler.ts`: the convergence phases after the terminal write.
- The test files: `src/workflows/execute-analysis.test.ts` (fake pool, the fake needs a transaction client) and `src/execution/run-canceler.test.ts` (fakes).
- No public type changes. `RunProvenanceEvent`, `CancelRunResult`, `RunCharge`, and `RunAuthorizer` keep their shapes. No change in the cli or in prov-kernel.
- The step names of the terminal block change in order and content. A workflow that a recovery replays across this change can meet a different step at the same position.
