# Design

## Context

`createRunCanceler` (`src/execution/run-canceler.ts`) cancels the parent and the children. Then it converges four ledgers. Its step phase calls only `sweepPendingStepExecutions` (`src/state/step-executions.ts`), which changes `pending` to `skipped`.

A child that the engine cancel cuts never writes its terminal row. `failStep` in `src/workflows/sandbox-step.ts` re-raises `DBOSWorkflowCancelledError` before any write, thus the row stays `running`. The cli reads the step rows for the sidebar rail and for the run detail dialog. There, `stepStateOf` maps `running` to a live step whose age continues to increase.

The canceler already computes `cutSteps` for the step metrics. These are the rows with a child id and no `completed_at`, read after the cancel. That list does not change.

## Goals / Non-Goals

**Goals:**

- After a successful `cancel`, no step row of the run stays `running`.
- A terminal row that a child wrote first keeps its status.

**Non-Goals:**

- A provenance record of the canceled run. The canceler emits no `run_completed` and no `step_completed`. That gap is older than this change, and the coordinator records it as a deferred finding.
- A change to the workflow body, to `collectAndComplete`, or to the cooperative cancel (option C of issue #250).
- A change to `CancelRunResult`.

## Decisions

**A new helper, not a wider sweep.** `cancelRunningStepExecutions(pool, runId, reason)` is a separate helper. `sweepPendingStepExecutions` stays as it is, because `collectAndComplete` calls it and `skipped` means "never started". A cut step started, thus `canceled` is the correct status. This agrees with the meaning that `step-execution-tracking` gives `canceled`: a step that stopped mid-flight.

**Each `running` row of the run, in one guarded statement.** After the engine cancel of the parent with the child cascade, no row of the run can correctly continue to run. Thus the helper updates `WHERE run_id = $1 AND status = 'running'` in one statement. It does not read each row before the write. The guard is the race protection: the statement does not touch a row that a child wrote first.

A write for each id of `cutSteps` was rejected. It is a loop of writes, and it must have the same guard.

**The duration in SQL.** `started_at` and `completed_at` are `TEXT` columns that hold ISO 8601 strings. Thus the statement casts them: `duration_ms = (EXTRACT(EPOCH FROM ($2::text::timestamptz - started_at::timestamptz)) * 1000)::bigint`, where `$2` is the `completed_at` value of the write. The statement also writes `completed_at = $2::text`. Postgres gives one type to a parameter, thus without the `::text` step it rejects `$2` as text and as `timestamptz` in the same statement (error 42P08). The value is NULL when `started_at` is NULL. Thus the canceler does not read the times of each row.

**The reason literal.** The helper takes the reason as a parameter. The canceler gives `EXTERNAL_CANCEL_REASON` (`external_cancel`), the same literal as the run row.

**Two guarded writes in one phase.** The step phase runs the pending sweep, then the running settle, each in its own `try`. A failure of one is logged, and it does not skip the other or the later phases. `converged.steps` is true only when the two writes succeed.

The settle runs whether or not the run-row write changed the row. A run that completed at the same time has no `running` rows, thus the write changes nothing. A failed run-row write still comes after a real engine cancel.

## Risks / Trade-offs

- [A child step in flight at the cancel can end after the settle] → Its unconditional terminal write can change `canceled` to `completed` or `failed`. That row then records what the child really did. The run row stays `canceled`, because `collectAndComplete` does not run on the canceled parent.
- [The in-memory pool fake of `run-canceler.test.ts` matches the SQL text] → The fake must answer the new statement and apply its guard. Thus the race assertions continue to test the state, not a stub of it.
