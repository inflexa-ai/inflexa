# Give the reads of the work that waits for the person, over each analysis

## Why

The cli change `add-the-attention-read` (#645) gives one read of the work that waits for the person: the open asks, the runs that run, the runs that ended and that the person did not see, and the newest threads, over each analysis. Each harness read of the runs and of the threads takes one analysis, or the newest run of each analysis of a list. Thus the cli cannot build those lists in a fixed count of statements.

## What Changes

- Add a grouped read that gives the progress of each run of a list of run ids, in one statement: the analysis, the thread, the status, the plan title, the done and total step counts, and the times. It shares one copy of the plan title and step count SQL with the newest-run read of #644.
- Add a read that gives the terminal runs that ended at or after a time, over each analysis. It skips a list of run ids. It gives the newest first, with a limit, in one statement.
- Add `listRecentThreads` to the thread store. It gives the newest live threads over each analysis, of one type, with a limit, in one statement.
- Add one migration with two indexes: the runs by their completion time, and the live threads by their update time. Thus the two reads over each analysis do not sort the whole history.
- Export the two run reads and their entry types from the package root.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `analysis-summary-reads`: two grouped run reads join the reads that summarize the analyses, and the package root exports them.
- `harness-thread-store`: the store lists the newest threads over each analysis, and the table gains an index on the update time of the live rows.

## Impact

- `src/state/analyses-metrics.ts`, `src/state/index.ts`, and `src/index.ts`.
- `src/memory/thread-store.ts` (the new method of `ThreadStore`).
- A new migration in `src/state/migrations/`, registered in `src/state/migrations/index.ts`. `src/state/thread-parent-columns.test.ts` pins the migration names.
- No change to `askGateway.pending()`: it already gives each pending ask of each analysis in one statement.
- No version bump of the package. The developer of the pull request controls the release.
