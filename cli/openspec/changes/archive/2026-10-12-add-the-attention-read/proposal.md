# Read the work that waits for the person, over each analysis

## Why

A client that shows what waits for the person reads one analysis at a time: the asks, the runs, and the threads (#645). The ask route reads each open ask of the ledger, then drops the asks of the other analyses. A thread on the wire has no flag for a turn that runs or for an open ask. Thus a client sends `GET {T}/turns` for each thread. No record tells which terminal run the person saw.

## What Changes

- `GET /api/v1/attention` gives four lists over each analysis:
  - `asks`: each open ask, with the name of its analysis, and `stale` when its thread has no turn that runs
  - `activeRuns`: each run with a live workflow, with its plan title and its step counts
  - `unseenRuns`: each terminal run that the person did not mark as seen
  - `recentThreads`: the newest conversation threads, with the name of the analysis. `limit` sets the count, with a default of 10.
- `POST {A}/run/:runId/seen` marks a terminal run as seen. SQLite keeps the mark. A run that ended before this change counts as seen.
- `ThreadSummary` gains `runningTurnId` and `pendingAsks`, in each route that gives a thread.
- Each list costs a fixed count of reads, never one read for each analysis. `activeRuns` uses the liveness rule of the busy gate.
- The read keeps these bounds and limits:
  - `activeRuns` and `unseenRuns` hold at most 200 items each.
  - An item whose analysis has no SQLite row drops, because no `{A}` route can open it.
  - `unseenRuns` holds the unseen runs among the newest 200 ended runs since the baseline. The count of the seen marks does not change the size of a read.
  - A thread route that writes reads the asks before its write, thus a failed ask read gives 500.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the attention read, the seen mark of a run, and the turn and ask fields of a thread. The route groups gain the attention read.
- `data-model-storage`: the tables of the seen marks and of the seen baseline, and their index.
- `data-model-db-access`: the write of a seen mark, the read of the seen state, and the read of the names of a list of analyses.

## Impact

- `src/server/routes/attention.ts` (new), `src/server/app.ts`, `src/server/routes/conversation.ts`, `src/server/routes/runs.ts`, `src/server/turns.ts`, and `src/server/durable_work.ts`.
- `src/api/attention.ts` (new), `src/api/conversation.ts`, and `src/api/runs.ts`.
- `src/db/primary_migrations.ts` (migration 12), `src/db/primary_query.ts`, and `src/db/primary_mutation.ts`.
- Each fixture that builds a `ThreadSummary`, for example `src/test_support/threads.ts`.
- The cli needs the harness change `add-the-attention-read`: the progress read of a list of runs, the read of the runs that ended after a time, and `listRecentThreads`.
