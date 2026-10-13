# Design

## Context

See `proposal.md` for the motivation. The cli change of the same name is the consumer.

- `src/state/analyses-metrics.ts` holds the grouped reads of #644. `queryLatestRunsByAnalyses` has the plan title SQL and the step count `LATERAL` subquery, and its row mapping trims the title with `titleOf`.
- The run reads of `src/state/runs.ts` take one analysis or one thread. Nothing reads runs over each analysis.
- Each terminal write stamps `completed_at` with `new Date().toISOString()`: `updateRunStatus` and `markRunCanceledIfActive` (`src/state/runs.ts`). Thus each `completed_at` is a fixed-width UTC ISO string, and its text order is its time order.
- The indexes of `cortex_runs` cover `analysis_id`, `thread_id`, `(analysis_id, started_at, run_id)`, and the partial unique active plan. None covers `completed_at`.
- `createThreadStore(pool).listThreads` takes one analysis. `THREAD_COLUMNS` and `toThread` in `src/memory/thread-store.ts` are the one projection and the one mapping of a thread row. The thread indexes cover `analysis_id` (live rows) and `parent_thread_id`. None covers `updated_at`.
- The cli reads the liveness of a workflow from `dbos.workflow_status` itself (`cli/src/server/durable_work.ts`). The harness exports no read of that table.

## Goals / Non-Goals

**Goals:**

- A fixed count of statements for each list of the cli attention read.
- One copy of the plan title and step count SQL.
- No sort of the whole run history or thread history for a read over each analysis.

**Non-Goals:**

- No read of the liveness of a workflow in the harness. The cli keeps its one copy of that rule. See "The liveness rule stays in the cli".
- No change to `askGateway.pending()`. It gives each pending ask of each analysis in one statement already.
- No change to `listThreads`, `queryLatestRunsByAnalyses`, or `LatestRunSummary`.
- No version bump of the package.

## Decisions

### The progress read shares the SQL of the newest-run read

Add `queryRunProgressByRuns(pool, runIds)` to `src/state/analyses-metrics.ts`. Its entry type is `RunProgressSummary`: the fields of `LatestRunSummary` plus `threadId: string | null`.

The plan join, the title `CASE`, and the step count `LATERAL` become one module constant of SQL text over a run alias `r`. The two reads put it after their own run selection:

- the newest-run read selects `r` with its `LATERAL` over `unnest($1::text[])`, as today
- the progress read selects `r` from `cortex_runs WHERE run_id = ANY($1::text[])`, and orders by `started_at DESC, run_id DESC`

The plan join stays on `plan_id` AND `analysis_id`. One row mapping serves the two reads, and `titleOf` stays the one trim. A second SQL copy for the new read was rejected, because two copies drift.

### The ended-run read walks a new index

Add `queryRunsEndedSince(pool, { since, exceptRunIds, limit })` to the same file. Its entry type is `EndedRunSummary`: `{ analysisId, runId, status: TerminalRunStatus, completedAt: string }`. `TerminalRunStatus` is `Exclude<RunStatus, "running" | "suspended_insufficient_funds">`, beside `RunStatus` in `src/state/schema.ts`. The statement:

```sql
SELECT analysis_id, run_id, status, completed_at
  FROM cortex_runs
 WHERE status IN ('completed', 'partial', 'failed', 'canceled')
   AND completed_at >= $1
   AND run_id <> ALL($2::text[])
 ORDER BY completed_at DESC, run_id DESC
 LIMIT $3
```

`since` compares as text. The caller gives it in the form of `toISOString()`, the form of each stamp, thus the text order is the time order. An empty `exceptRunIds` still sends the query, because the read has no list to be empty.

### The thread store lists the newest threads

Add `listRecentThreads({ limit, type? })` to `ThreadStore`. It uses `THREAD_COLUMNS` and `toThread`:

```sql
SELECT <THREAD_COLUMNS> FROM cortex_analysis_threads
 WHERE deleted_at IS NULL [AND thread_type = $2]
 ORDER BY updated_at DESC, thread_id
 LIMIT $1
```

The limit clamps to 1 to 200, the bounds of `listThreads`. A function in `analyses-metrics.ts` was rejected, because it would copy the projection and the mapping of a thread row.

### One migration adds the two indexes

A new migration `20261013120000_index_the_ended_runs_and_the_recent_threads`:

```sql
CREATE INDEX IF NOT EXISTS idx_cortex_runs_completed
  ON cortex_runs(completed_at DESC, run_id DESC);
CREATE INDEX IF NOT EXISTS idx_cortex_analysis_threads_recent
  ON cortex_analysis_threads(updated_at DESC, thread_id) WHERE deleted_at IS NULL;
```

The thread index is partial on the live rows, the same predicate as the read. It registers in `src/state/migrations/index.ts` after each existing entry. `src/state/thread-parent-columns.test.ts` pins the names.

### The liveness rule stays in the cli

The cli attention read needs the runs with a live workflow. The cli holds the one liveness rule over `dbos.workflow_status` (`RUN_IS_LIVE` in `cli/src/server/durable_work.ts`), and the busy gate reads it. A harness copy would be a second rule that can drift. Thus the cli lists the live run ids with its rule, then calls `queryRunProgressByRuns`. A move of the rule into the harness was rejected for this change, because it changes the busy gate and the cli `countLiveDurableWork`.

### The root barrel exports the new names

`src/index.ts` and `src/state/index.ts` export `queryRunProgressByRuns`, `queryRunsEndedSince`, `RunProgressSummary`, `EndedRunSummary`, and `TerminalRunStatus`. `ThreadStore` is already exported. `src/index.ts` also exports `ListRecentThreadsInput`, the input type of the new method, thus an embedder can type a call of it.

## Risks / Trade-offs

- [The skip list of the ended-run read grows with each seen mark of the person] → The cli passes its marks as one array parameter. A local install keeps a small count of runs. The cli design records this bound.
- [The two indexes add a write cost to each run and each thread update] → One more index entry for each write. The reads over each analysis would otherwise sort the history.

## Migration Plan

The new migration is additive and uses `IF NOT EXISTS`. The new reads and the new store method change no existing behavior.
