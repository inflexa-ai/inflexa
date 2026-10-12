# Design

## Context

See `proposal.md` for the motivation. The cli change of the same name is the consumer.

- Each run read in `src/state/runs.ts` takes one analysis id. The step reads in `src/state/step-executions.ts` take one run id. `loadPlan` in `src/state/plans.ts` takes one plan id.
- `src/state/analyses-metrics.ts` holds grouped reads over `= ANY($1::text[])`. Nothing calls them, and no test covers them. Its header names `routes/analyses-metrics.ts`, a file that does not exist.
- `queryDataProfileStatusByAnalyses` gives only the status, and it gives a row with a null status for a cleared analysis.
- `profileDatasetFileCount` in `src/app/data-profile-view.ts` is the one rule for the file count of a stored profile. It reads only `partition`, `coverage`, and `kinds`.
- The terminal writes `completeDataProfile` and `failDataProfile` stamp `data_profile_completed_at` under a CAS on `running`. `settleTerminalWrite` in `src/tasks/data-profile.ts` is the exactly-once point of a settle. Its doc says so, and it records the run metric there.
- `DataProfileDeps` has no observation hook. `CoreWorkflowDeps.dataProfile` is `Omit<DataProfileDeps, "usageRecorder" | "toolOutputStore">`, thus a new optional field of the deps reaches the embedder with no change to the assembly.

## Goals / Non-Goals

**Goals:**

- A fixed count of statements for a page of analyses: one for the newest runs, one for the profiles.
- A newest-run read whose cost does not grow with the run history.
- One settle notice for each settled claim of a profile.

**Non-Goals:**

- No notice for a terminal change outside the workflow body: `expireStaleDataProfile`, `reconcileOrphanedDataProfile`, and the immediate completion of an empty manifest in the trigger. The user selected the notice at the settle point of the body. `expireStaleDataProfile` has no production caller. The orphan reset repairs a row of a crashed host, thus its time is not the time of the profile end. The empty-manifest completion follows an input removal, and the embedder records that removal as an activity.
- No change to the single-analysis reads and no change to `queryRunCountsByAnalyses` or `queryThreadCountsByAnalyses`.
- No version bump of the package. The developer of the pull request controls the release.

## Decisions

### The newest-run read lives beside the other grouped reads

Add `queryLatestRunsByAnalyses(pool, analysisIds)` to `src/state/analyses-metrics.ts`, and correct the stale header of that file. The statement:

- expands the ids with `unnest($1::text[])`
- takes the newest run of each id with a `LATERAL` subquery: `WHERE analysis_id = a.id ORDER BY started_at DESC, run_id DESC LIMIT 1`. The subquery reads the new index `idx_cortex_runs_analysis_started` (see below), thus it reads one index entry for each analysis.
- joins `cortex_plans` on `plan_id` AND `analysis_id`, thus a plan of a different analysis gives no title. That is the scope rule of `loadPlan`.
- counts the step rows of the selected run only, in a second `LATERAL` subquery over the primary key prefix `(run_id)`. `COUNT(*) FILTER (WHERE status = 'completed')` gives the done count.

The SQL takes `plan->>'title'` only when `jsonb_typeof(plan->'title')` is `string`. The read then trims it with the JavaScript `trim()`, and a blank title reads as `null`. That is the rule of `planTitleOf` in the cli, also for a title edged with Unicode whitespace. The harness cannot import the cli, thus the rule has one copy for each package. A DISTINCT ON over all runs was rejected, because Postgres projects the step counts of each run before the distinct.

The entry type is `LatestRunSummary`: `{ analysisId, runId, status: RunStatus, planTitle: string | null, doneSteps: number, totalSteps: number, startedAt: string, completedAt: string | null }`. The counts are cast to `int` in SQL, because `pg` gives a `bigint` as a string.

### A composite index bounds the newest-run read

The index `idx_cortex_runs_analysis` covers only `analysis_id`. With it, the newest-run subquery sorts each run of an analysis, and the run history of an analysis grows with no bound. A new migration `20261012120000_index_the_runs_by_start` adds:

```sql
CREATE INDEX IF NOT EXISTS idx_cortex_runs_analysis_started
  ON cortex_runs(analysis_id, started_at DESC, run_id DESC);
```

The migration registers in `src/state/migrations/index.ts` after each existing entry. `started_at` is an ISO 8601 text, thus its text order is its time order. The old index stays, because a drop is a separate decision with its own risk.

### The profile read amends the existing grouped read

Amend `queryDataProfileStatusByAnalyses` in place. It has no caller, thus the change of its entry shape breaks nothing. The new entry type is `DataProfileSummary`: `{ analysisId, status: DataProfileLifecycleStatus, completedAt: string | null, profiledFiles: number | null }`.

- `WHERE analysis_id = ANY($1::text[]) AND data_profile_status IS NOT NULL` drops the cleared rows, the same collapse as `loadDataProfileStatus`.
- The statement selects `data_profile_result->'partition'`, `->'coverage'`, and `->'kinds'`, not the whole result. The JSON transfer stays small. Postgres still detoasts each result value once, and the page size bounds that cost.
- `profiledFiles` comes from `profileDatasetFileCount` over those parts. Narrow its parameter to `Pick<DataProfileResult, "partition" | "coverage" | "kinds">`. Each current caller passes a whole result, which still satisfies the narrower type. The state module imports the helper from `src/app/data-profile-view.ts`. That file imports only `contracts/`, thus the import adds no runtime graph. A copy of the count rule in SQL was rejected, because two copies drift.

### The settle notice is a notice hook on the deps

- `src/lib/hooks.ts` gains the notice name `notifyDataProfileSettled`.
- The data-profile module exports `DataProfileSettlement` (`{ analysisId, status: "completed" | "failed", completedAt: string }`) and `NotifyDataProfileSettled` (`(settlement) => ResultAsync<void, NoticeFailure>`).
- `DataProfileDeps` gains `notifyDataProfileSettled?: NotifyDataProfileSettled`.
- The stamped arm of `DataProfileTerminalWrite` gains `completedAt`. The terminal writes return the stamped `data_profile_completed_at` with `RETURNING`.
- `settleTerminalWrite` becomes async. After an accepted stamp it records the metric as now, and then it delivers the notice through `deliverNotice` when the deps bind one. Each call site awaits it. A refused stamp logs and sends nothing.

The notice runs in the workflow body, not in a step. A recovery replay runs the body again, but the CAS refuses the second stamp. Thus the notice does not run again. A crash between the stamp and the notice loses that one notice. The embedder uses the notice for a time of activity, thus a lost notice costs one late timestamp and no correctness.

### The root barrel exports the new names

`src/index.ts` and `src/state/index.ts` export `queryLatestRunsByAnalyses`, `queryDataProfileStatusByAnalyses`, `LatestRunSummary`, and `DataProfileSummary`. `src/index.ts` also exports `DataProfileSettlement` and `NotifyDataProfileSettled`, because they type a field of `DataProfileDeps`, which the barrel exports (`harness-embedder-exports`).

## Risks / Trade-offs

- [The composite index adds a write cost to each run insert] → One run insert is rare next to the reads of a list. The cost is one more index entry.
- [A hung notice holds the profile workflow open] → This is the same contract as each other notice hook of the harness. The embedder realization is a local SQLite write.
- [The title rule has a copy in the cli] → The two rules are short, and the specs of each package name them.

## Migration Plan

The new migration is additive and uses `IF NOT EXISTS`. The new deps field is optional, thus an embedder that binds nothing keeps its behavior.
