# Tasks

## 1. The indexes

- [x] 1.1 Add the migration `20261013120000_index_the_ended_runs_and_the_recent_threads` with `idx_cortex_runs_completed` and `idx_cortex_analysis_threads_recent`, and register it in `src/state/migrations/index.ts`. Add the name to the pin of `src/state/thread-parent-columns.test.ts`. Make sure with a Postgres test that the two indexes exist after the migrations.

## 2. The run reads

- [x] 2.1 Move the plan join, the title `CASE`, and the step count `LATERAL` of `queryLatestRunsByAnalyses` into one SQL constant and one row mapping in `src/state/analyses-metrics.ts`. Make sure that each existing test of `src/state/analyses-metrics.test.ts` passes with no change.
- [x] 2.2 Add `queryRunProgressByRuns` and `RunProgressSummary` on that shared SQL. Do a Postgres test (`withSchema`) of these cases:
  - two runs of two analyses, one with no thread, and an unknown id
  - the step counts
  - a plan of a different analysis
  - the start order

   Use the counting querier to make sure that a list of 20 ids sends one query and an empty list sends none.
- [x] 2.3 Add `TerminalRunStatus` to `src/state/schema.ts`, and add `queryRunsEndedSince` and `EndedRunSummary`. Do a Postgres test of these cases:
  - a run that completed before the time
  - the four terminal statuses after it, and a run that still runs
  - the skip list, the limit, and the tie order on `run_id`

   Make sure that the read sends one query.

## 3. The thread read

- [x] 3.1 Add `listRecentThreads({ limit, type? })` to `ThreadStore` in `src/memory/thread-store.ts`, with `THREAD_COLUMNS` and `toThread`. Do a Postgres test in `src/memory/thread-store.test.ts`: threads of two analyses in update order, an archived thread, the type filter, the limit clamp, and one query for threads of 20 analyses.

## 4. The package surface

- [x] 4.1 Export `queryRunProgressByRuns`, `queryRunsEndedSince`, `RunProgressSummary`, `EndedRunSummary`, and `TerminalRunStatus` from `src/state/index.ts` and `src/index.ts`, and `ListRecentThreadsInput` from `src/index.ts`. Extend `src/state/analysis-summary-reads.barrel.test.ts` to import the reads and their entry types from the package root, and make sure that it passes. The cli typecheck imports `ListRecentThreadsInput` from the root.
- [x] 4.2 Run `bun run format:file` on the changed files in `src/`. Then run `bun run lint`, `tsc -p tsconfig.build.json`, and `bun run test:full` on the changed test files. Make sure that each passes.
