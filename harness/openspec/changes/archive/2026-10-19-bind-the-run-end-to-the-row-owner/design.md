# Design

## Context

Refer to `proposal.md` for the race. These facts of the current code shape the approach:

- The terminal block of the body (`collectAndComplete`, `src/workflows/execute-analysis.ts`) runs in this order: the `DBOS.now()` terminal clock read, the `run_completed` emit, `persist-final-status`, `persist-synthesis-outcome`, `sweep-pending-steps` or `suspend-analysis`, `close-running-charge`, `revoke-run-auth`, and then the UI stream parts.
- The run canceler (`src/execution/run-canceler.ts`) runs the engine cancel first and the conditional terminal write second. Then it emits only when the write won, but it settles the step rows, closes the charge, and revokes the mandate on each path.
- DBOS 4.23.6 reads the cancel state of the workflow when a step starts (`checkIfCanceled` in `dbos-executor.js`). A step that started before a cancel runs to its end. The next step throws `DBOSWorkflowCancelledError`.
- The emit of the body comes before the status write on purpose. The cli dev run polls the run row, and it flushes the provenance and exits when the row leaves `running` (`cli/src/modules/harness/dev/run.ts`, `waitForRunTerminal`). An emit after the visible write can miss that flush.
- The body emits outside a durable step on purpose. A recovery replay must fire the run end again. The `atMs` comes from the checkpointed `DBOS.now()`, thus the event that fires again is identical, and the host merges it.
- `updateRunStatus` takes a `Querier`, which is a `Pool` or a `PoolClient`. `withTransaction` (`src/lib/db-result.ts`) is the transaction helper of the harness.
- The archived change `guard-the-final-run-status-write` (decision D3) covers a recovery that runs the status step again after its own write landed. That recovery must still close the charge and revoke the mandate.

## Goals / Non-Goals

**Goals:**

- One run end in the provenance document for each run, from the writer that wins the row.
- One charge close and one revoke for each run, with the outcome of the status that the row holds.
- The cli flush still captures the run end of the body, and a recovery replay still fires it again.

**Non-Goals:**

- No change to the order of the canceler phases before its terminal write, and no change to the engine cancel.
- No change to the step settle of the canceler. It still runs on each path, because it changes only `pending` and `running` step rows.
- No change for the steps of the terminal block that are not run-end acts: `persist-synthesis-outcome`, `sweep-pending-steps`, `suspend-analysis`, and the UI stream parts. An engine cancel can still cut them after a won write of the body. The canceler sweeps the step rows, and the run-event reader synthesizes the terminal part from the row.
- No change in the cli or in prov-kernel.

## Decisions

### D1: The winner of the row owns each act of the run end

The rule "the first terminal write wins" already decides the row and the outcome metrics. This change extends it to the `run_completed` emit, the charge close, and the revoke. The body does these acts only when it owns the row. The canceler does them only when its write changes the row.

Alternatives:

- After a refused write, the canceler reads the recorded steps of the body from the engine. It closes the charge for the body when no `close-running-charge` step is recorded. This design rejects it. The canceler then depends on the step names of the body. A close of the body that is in progress during the read is not recorded yet, thus the charge can close two times.
- The canceler writes the row first, and it cancels the engine only when it wins. This design rejects it. After a won write, an engine cancel that fails leaves a `canceled` row over a workflow that continues, and a retry stops at `already_terminal`. Also, the body can start its own close after the write of the canceler and before its engine cancel.

### D2: The body emits the run end inside the status write transaction

`persist-final-status` runs `updateRunStatus` on the client of a `withTransaction` call. When the update reports a changed row, the step emits `run_completed` before the transaction commits. The update holds the row lock until the commit. The conditional write of the canceler waits for that lock, and then its condition is false. No reader sees the terminal row before the commit, thus the cli flush captures the run end first. The signature of `emitRunEvent` returns `void`, thus the emit completes before the commit.

The transaction holds only the update and the emit. The charge close and the revoke are calls to the host, thus they run after the commit, in the same step.

Alternative: emit after an autocommit write. This design rejects it, because the poll of the cli can see the row before the emit. That is the race that the current comment of the body describes.

### D3: The won write closes the charge and revokes in the same step

On the won path, `persist-final-status` records the metrics, closes the charge, and revokes the authorization after the commit. An engine cancel cannot stop a step that started, thus a won write always completes these acts. The outcome of the charge and the reason of the revoke keep their current mapping from the status.

The charge close and the revoke now run before `persist-synthesis-outcome`, `sweep-pending-steps`, and `suspend-analysis`. The suspension branch lists its steps with no order. The `workflow-failure-lifecycle` delta states the new order.

Alternative: keep `close-running-charge` and `revoke-run-auth` as separate steps after a won write. This design rejects it, because an engine cancel between the steps cuts them, and the canceler no longer closes for a refused write.

### D4: A refused or failed write closes and revokes in their own steps

When the status step reports a refused or failed write, the body runs `close-running-charge`, then `revoke-run-auth`, then the emit. A refused write has two causes:

- The canceler won the row. Its engine cancel came before its write, and its write came before the refused write of the body. Thus `close-running-charge` throws the engine cancel, and the body stops before each act.
- A recovery ran the status step again after its own write landed. No cancel occurred, thus the steps run and the body completes the run end.

A failed write keeps its current behavior: the body closes the charge, revokes, and emits. The row then stays `running`, the same as now. The finalisation hook requires this behavior, because a failed act must not stop the other acts.

### D5: One emit outside the step covers the replay and the refused path

The step function sets a local flag when it emits inside the transaction. After the step, the body emits `run_completed` when the flag is not set:

- A won step that DBOS gives from the cache did not run its function in this execution. The flag is not set, thus the body fires the run end again with the same values.
- A refused or failed write did not emit. The body emits after the steps of D4.
- A won step that ran in this execution emitted already. The flag is set, thus the body does not emit again.

The step returns whether its write won, thus a replay reads the same value from the cache.

Alternative: emit after the step on each path. This design rejects it, because each run would then emit its end two times.

### D6: The canceler separates a refused write from a failed write

The canceler keeps the result of its terminal write in three states: changed, refused, and failed.

- Changed: the canceler emits, closes the charge, and revokes, as now.
- Refused: the body owns the run end. The canceler does not close or revoke. `converged.charge` and `converged.mandate` are true, because the canceler has nothing to converge. This is the same reason that makes `converged.mandate` true for a row with no jti.
- Failed: the canceler does not close or revoke. The row stays `running`, thus a second cancel converges the run. `converged.charge` is false, and `converged.mandate` is false for a row with a jti.

The step settle runs on each of the three paths.

Alternative: false flags for a refused write. This design rejects it. A host alerts on a false flag, and a refused write is a normal race. The TUI reads the flags only when `finalStatus` is `canceled` (`cli/src/tui/hooks/activity_panel.ts`), thus the TUI shows no change.

### D7: The dead fixture keys go away

The fixture key `"SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id"` in `src/workflows/execute-analysis.test.ts` matches no query of the body. Each occurrence goes away. The fake pool also gets a `connect()` for the transaction of D2.

## Risks / Trade-offs

- [A crash occurs after the close or the revoke of a won step, before DBOS records the step] → The recovery runs the step again. The fallback steps close and revoke again. This is the at-least-once rule of a DBOS step, and each step has the same risk now. The combined step makes the window a little wider: a crash after the revoke also repeats the close. No host contract gives an idempotency key, and the realizations are outside this repository.
- [The commit fails after the emit, or the status write fails] → The provenance holds the run end of the body, and the row stays `running`. A later cancel then wins the row. It records a second run end and closes the charge a second time. The current code has the same result. A fix needs a decision about a run end with no owner, thus this change does not fix it.
- [The canceler waits for the row lock of the body] → The transaction holds one update and a synchronous emit, thus the wait is short.
- [A workflow recovers across this change inside its terminal block] → The steps at a position can differ from the recorded steps. DBOS can then fail the replay. The user did not ask for compatibility with an earlier step order.
- [A host emit realization starts asynchronous work] → The signature of `emitRunEvent` requires a synchronous emit. The cli bus marks the record dirty before the emit returns.
