# Tasks

## 1. The grouped reads

- [x] 1.1 Add the migration `20261012120000_index_the_runs_by_start` with `idx_cortex_runs_analysis_started`, and register it in `src/state/migrations/index.ts`. Make sure with a Postgres test that the index exists after the migrations, and that each test that pins the migration list passes.
- [x] 1.2 Add `queryLatestRunsByAnalyses` and its `LatestRunSummary` entry type to `src/state/analyses-metrics.ts`. Correct the stale header of that file. Do a Postgres test (`withSchema`). Make sure that the read gives the newest run of each analysis, and no entry for an analysis with no run. The test also covers the step counts with the synthesis row, a plan of a different analysis, and a blank title.
- [x] 1.3 Amend `queryDataProfileStatusByAnalyses` to give `DataProfileSummary` entries. Narrow the parameter of `profileDatasetFileCount` to the three fields that it reads. Do a Postgres test of a completed profile with a partition, a running profile with no result, and a cleared row.
- [x] 1.4 In the tests of 1.2 and 1.3, make sure that each read sends one query for a long list. An empty list sends no query. Use a querier that counts its calls.

## 2. The settle notice

- [x] 2.1 Add the notice name `notifyDataProfileSettled` to `src/lib/hooks.ts`. Add `DataProfileSettlement`, `NotifyDataProfileSettled`, and the optional `notifyDataProfileSettled` field of `DataProfileDeps`. Make sure that `tsc -p tsconfig.build.json` passes.
- [x] 2.2 Give `completedAt` on the stamped arm of `DataProfileTerminalWrite` from `completeDataProfile` and `failDataProfile`. Make sure that the tests of `src/state/data-profile.test.ts` pass, with one new assertion on the stamped time.
- [x] 2.3 Make `settleTerminalWrite` deliver the notice after an accepted stamp, and await it at each call site. Do a test of the profile workflow body for these cases:
  - A completed settle and a failed settle each call the notice one time with the stamped time.
  - A refused stamp calls nothing.
  - A failed notice keeps the settled row.
  - Deps with no notice call nothing.

## 3. The package surface

- [x] 3.1 Export the two reads, `LatestRunSummary`, and `DataProfileSummary` from `src/state/index.ts` and `src/index.ts`. Export `DataProfileSettlement` and `NotifyDataProfileSettled` from `src/index.ts`. Make sure that `tsc -p tsconfig.build.json` passes, and that a test imports them from the package root.
- [x] 3.2 Run `bun run format:file` on the changed files. Then run `bun run lint`, `tsc -p tsconfig.build.json`, and `bun test` of the changed test files. Make sure that each passes.
