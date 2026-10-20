# Design

## Context

Refer to `proposal.md` for the gap. These facts of the current code and of DBOS 4.23.6 shape the approach:

- `persist-final-status` (`src/workflows/execute-analysis.ts`, `collectAndComplete`) runs `updateRunStatus` in a `withTransaction` call. A won write emits `run_completed` before the commit, then it closes the charge and revokes inside the step. A failed write returns `"failed"` and does not throw. Thus a DBOS step retry cannot apply to it now.
- After a refused or failed write, the body runs `close-running-charge` and `revoke-run-auth`, then it emits `run_completed` when the step did not emit. On a failed write the row stays `running`.
- The run canceler (`src/execution/run-canceler.ts`) reads the row, cancels the engine, reads the cut steps, and then does its conditional terminal write. When the write changes the row, it emits, closes the charge, and revokes.
- The engine cancel does not change a workflow in `SUCCESS` or `ERROR` (`system_database.js`, `#cancelWorkflows`). A workflow outcome does not overwrite `CANCELLED` (`#recordWorkflowOutcome`).
- A workflow reaches `ERROR` also from a throw before the terminal block, for example a failed `seed-step-executions` step. No act of the run end ran on that path. A workflow reaches `CANCELLED` also from the suspension self-cancel after the terminal block, and from each engine cancel of the canceler.
- `StepConfig` gives `retriesAllowed`, `maxAttempts`, `intervalSeconds`, and `backoffRate`. DBOS retries only a thrown error. It checks the cancel of the workflow before each attempt. After the last attempt, it records and throws `DBOSMaxStepRetriesError`.
- `DBOS.setEvent` is a durable operation of a workflow, not of a step. It checks the cancel of the workflow. `DBOSClient.getEvent` reads an event from outside a workflow, and a zero timeout gives `null` at once when the event is absent.
- The canceler reaches the engine through a `DBOSClient` over the application pool, because the host process can have no launched engine (`src/execution/dbos-workflow-purger.ts`).
- The cli binds `createNoopRunCharge` and `createLocalRunAuthorizer`. Thus in the cli the visible harm is the second run end in the provenance document. A managed host also gets a second charge close and a second revoke.

## Goals / Non-Goals

**Goals:**

- After a failed status write, one run end for each run, from the body.
- No open charge and no live mandate after a failed status write.
- A row that leaves `running` after the canceler repairs it, with the status that the body emitted.
- Fewer runs on the failed path, through a retry with backoff of the status write.

**Non-Goals:**

- No change to the won path, the refused path, the in-transaction emit, or the order of the terminal steps.
- No change to a run that ends before its terminal block, for example a throw in the scheduler. The canceler still owns that run end.
- No idempotency key for `RunCharge.close` or `RunAuthorizer.revoke`.
- No change in the cli or in prov-kernel.

## Decisions

### D1: The status write retries with backoff

The step runs with `retriesAllowed: true`, `maxAttempts: 5`, `intervalSeconds: 1`, and `backoffRate: 2`. Thus the waits are 1, 2, 4, and 8 seconds. DBOS retries only a thrown error, thus the step throws when the transaction of an attempt gives an `err`. A refused write does not throw, thus it does not retry.

The last attempt does not throw. `DBOS.stepStatus` gives the current attempt and the maximum. When the transaction of the last attempt gives an `err`, the step logs `ledger write failed` with the `runId`, the status, and the cause. Then it returns `"failed"`. DBOS records that result, thus a replay gives `"failed"` from the cache. Each attempt before the last logs its failure at the warning level.

The body catches nothing. A cancel before an attempt throws `DBOSWorkflowCancelledError` out of `DBOS.runStep`, and the body stops as now. A failure to record the step also goes to DBOS as now.

The emit in the transaction fires at most one time in one execution. An attempt can emit, and then its commit can fail. The next attempt then must not emit again. The existing `emittedInStep` flag guards the emit across the attempts.

The retry does not stop early for a permanent error. The update has no constraint to violate, and D5 removes the one value that Postgres rejects. Thus each other failure can be transient.

Alternatives:

- The body catches `DBOSMaxStepRetriesError` and each other error of the step as the failed write. This design rejects it. DBOS can also throw when it records the result of a won step, after the step closed the charge and revoked. That catch would then close and revoke a second time in the same execution.
- A retry loop inside the step. This design rejects it. DBOS gives the backoff and the cancel check before each attempt.

### D2: The body keeps the run end after a failed write

After a failed write, the body closes the charge, revokes the authorization, and emits `run_completed`, as now. The row has no owner, and the body is the only writer that knows the true status.

Alternative B, "the row owns, the body waits": the step throws, DBOS retries it, and then the workflow ends in `ERROR` with no act of the run end. This design rejects it:

- The charge stays open and the mandate stays live until someone aborts the run.
- The abort then records the run as `canceled`, also when each step and the synthesis completed. The true outcome is lost from the provenance and from the charge.
- The finalisation hook requires that a failed act does not stop the other acts.

Alternative C, "retries only": D1 alone. This design rejects it, because a failure that outlasts the retries still gives two run ends after an abort.

### D3: The body records its run end in the engine

After the failed-path acts, the body calls `DBOS.setEvent` with the key of the recorded run end. The value holds these fields:

- `status`: the status that the failed write tried to write
- `error`: the error that the failed write tried to write, or `null`
- `closed`: the result of the `close-running-charge` step
- `revoked`: the result of the `revoke-run-auth` step

The body records it only after a failed write. After a won or refused write, the row is terminal, thus the canceler never reads the record.

The record comes after the acts. A cancel that lands during the acts stops the body at the next durable operation, before the record. The canceler then finds no record, and it owns the rest of the run end. Thus an act can occur two times in that window, but no act is lost.

A throw of `setEvent` other than the cancel goes to the log, and the body continues. The finalisation hook requires that. The canceler then finds no record, and it acts as now.

The record comes before `persist-synthesis-outcome` and `sweep-pending-steps`. A cancel after the record cuts these steps. The synthesis columns of the row then stay unknown. The prior change accepted the same loss for a cancel after a won write.

A small module holds the event key and the type of the value. The body and the canceler import it.

Alternatives:

- The canceler reads the DBOS status of the workflow, and it treats an ended workflow as the owner of the run end. This design rejects it. `ERROR` also comes from a throw before the terminal block, where no act ran. The canceler would then leave the charge open and the mandate live. `CANCELLED` comes from the suspension self-cancel and from the own engine cancel of the canceler, thus it tells nothing. `SUCCESS` alone is correct, but it misses the suspension path and the synthesis-failure path, and the workflow output holds no error text.
- The body records the run end before the acts. This design rejects it. A cancel between the record and the acts then loses the acts.
- The canceler reads the recorded steps of the body. The change `bind-the-run-end-to-the-row-owner` (D1) rejected this, because the canceler then depends on the step names of the body.

### D4: The canceler reads the record before its terminal write

The canceler reads the record after the engine cancel and the read of the cut steps, and before its terminal write. After the engine cancel, no new durable operation of the body starts. The read has three results:

- **Present.** The body did the run end. The canceler writes the status and the error of the record with `updateRunStatus`, which is conditional on a `running` row. It emits nothing, closes no charge, and revokes no mandate. When the write changes the row, the canceler records the run outcome metric with the status of the record. It records no step outcome metric, because the children and the body recorded theirs. `converged.charge` is `closed` of the record, and `converged.mandate` is `revoked` of the record, for each result of the repair write. `finalStatus` is the status of the row after the write. A refused or failed repair write reads the row again, as a refused write does now.
- **Absent.** The canceler acts as now.
- **Failed.** The canceler does no terminal write and no act of the run end. A value that does not match the type of the record counts as a failed read. The flags are the flags of a failed terminal write. The row stays `running`, thus a second cancel converges the run.

The step settle runs on each path, as now. `outcome` stays `canceled` on each path after the engine cancel, the same as for a refused write now.

The read is an optional injected function of `RunCancelerDeps`, the same as `cancelWorkflows`. The production default calls `DBOSClient.getEvent` with a zero timeout. Each `DBOSClient` registers handlers on its pool, thus the purger and the canceler share one client for each pool. `src/execution/dbos-workflow-purger.ts` gives that client, and it keeps the injected logger as the engine logger. The `WorkflowPurger` interface does not change.

Alternative: the repair writes `canceled`. This design rejects it. The row would then disagree with the run end in the provenance and with the outcome of the charge close.

### D5: The status write removes NUL from the error text

`updateRunStatus` removes each NUL character from the error text with `stripNulCharacters` (`src/input-sanitization.ts`). Postgres rejects a NUL in text. The error text comes from step failures, from the synthesis error, and from a host refusal, and none of them removes NUL. Without D5, such a text fails each attempt of the body, and then each repair write of the canceler. The row then stays `running`, and it blocks a new run of the plan. The thread history writer removes NUL where it writes, and D5 obeys the same rule.

## Risks / Trade-offs

- [An attempt emits, its commit fails, and then a cancel lands] → The next attempt throws the cancel, and the canceler wins the row. The provenance then holds the run end of the body and the run end of the canceler. The emit before the commit causes this, and the cli flush requires that order.
- [A cancel lands while `close-running-charge` or `revoke-run-auth` runs on the failed path] → The act that runs completes, and the canceler does it again. No act is lost.
- [The database still fails when the body records the run end] → The record is absent, and the canceler acts as now. The two run ends of the current code then remain for this run.
- [The cancel and the read land while `setEvent` writes the record] → The canceler finds no record, and it does the run end a second time. The window is the duration of one insert.
- [A repair write fails for a reason that D5 does not remove] → The row stays `running`, and each later cancel tries the repair again. The current code writes `canceled` with `external_cancel` in this case.
- [The read of the record fails each time] → The canceler never writes the row, and the row stays `running`. An absent engine ledger gives this result. The engine cancel treats an absent ledger as nothing to cancel, but the read fails. A run that started has a ledger, thus only a removed ledger reaches this case.
- [The retries hold the run row `running` for up to 15 seconds after the last step] → A host that polls the row sees the end later. The terminal stream part also comes later.
- [A workflow recovers across this change inside its terminal block] → The durable operations at a position can differ from the recorded operations. The user did not ask for compatibility with an earlier step order.
