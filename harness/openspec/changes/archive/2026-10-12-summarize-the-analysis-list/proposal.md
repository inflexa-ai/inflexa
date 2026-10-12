# Give grouped analysis reads and a notice of each profile settle

## Why

The cli change `summarize-the-analysis-list` (#644) gives a summary of each analysis in one list page. The page must read the newest run and the data profile of each analysis in a fixed count of Postgres reads. But each harness read takes one analysis. The cli also records the time of the newest activity of each analysis, and a profile end is one such activity. A profile settles only in Postgres, and its workflow tells the embedder nothing.

## What Changes

- Add a grouped read that gives the newest run of each analysis of a list, in one statement. Each run carries its plan title and the done and total counts of its step rows.
- Extend the grouped data profile read of `analyses-metrics.ts` to give the status, the completion time, and the count of the profiled files of each analysis.
- Add an optional notice to the data-profile deps. The workflow calls it one time when it settles the profile row, with the analysis id, the outcome, and the completion time.
- Add an index on the runs of an analysis by their start time, thus the newest-run read does not sort the run history.
- Export the reads, their row types, and the notice types from the package root.

## Capabilities

### New Capabilities

- `analysis-summary-reads`: the grouped Postgres reads that summarize a page of analyses: the newest run of each analysis and the profile state of each analysis.

### Modified Capabilities

- `data-profile-observation`: the embedder hears each settle of a profile through an optional notice.
- `run-observation-seam`: the data-profile workflow still emits no provenance, but its deps carry the settle notice, which is not provenance.

## Impact

- `src/state/analyses-metrics.ts`, `src/state/runs.ts` or a sibling state file, `src/state/index.ts`, and `src/index.ts`.
- `src/tasks/data-profile.ts` and `src/state/data-profile.ts` (the terminal writes and the settle point).
- `src/lib/hooks.ts` (one new notice name).
- `src/app/data-profile-view.ts` (the parameter of `profileDatasetFileCount` narrows to the fields that it reads).
- A new migration in `src/state/migrations/` adds an index on `cortex_runs(analysis_id, started_at, run_id)`.
