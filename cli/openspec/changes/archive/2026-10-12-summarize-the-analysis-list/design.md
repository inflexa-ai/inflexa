# Design

## Context

See `proposal.md` for the motivation. The harness change of the same name gives the grouped reads and the settle notice.

- `GET /api/v1/analyses` (`src/server/routes/analyses.ts`, `analysisCollectionRoutes`) reads SQLite only, and `app.ts` mounts it with no `boot`.
- `listAnalysisPage` (`src/db/primary_query.ts`) orders by `created_at DESC, id DESC`.
- `workspaceBusyReasons` (`src/server/busy_gate.ts`) makes two Postgres reads for each analysis. `countLiveDurableWork` (`src/server/durable_work.ts`) gives one total for one analysis or for all of them, and no total for each analysis.
- `GET {A}/asks` filters the result of `askGateway.pending()` in memory. The pending set is small, because each pending ask holds a turn open.
- `prov.run_started` and `prov.run_completed` carry the times of the durable clock (`startedAtMs`, `completedAtMs`), and they fire again after a recovery. `prov.input_added` and `prov.input_removed` carry no time.
- `watchInputDrift` (`src/server/profile_queue.ts`) is the pattern of a bus subscriber of the server, wired in `serve.ts` with a stop at the shutdown.
- Migration 8 set the precedent: an additive `ADD COLUMN` appends at the end of the table.

## Goals / Non-Goals

**Goals:**

- A fixed count of reads for each list request: 3 SQLite statements (4 with the `project` filter) and, when the phase is `ready`, 4 Postgres reads.
- One busy rule for `GET {A}` and for the list.
- One stored activity time for the field and for the sort.

**Non-Goals:**

- No change to the `Analysis` entity type, `AnalysisView`, or `GET {A}`.
- No client fetcher and no TUI change. No client asks for the new fields yet. The consumer is the GUI.
- No activity for an input path rewrite (`relocateRawInputPrefix`). The anchor backstop rewrites the stored paths after a folder moved. The rewrite repairs a reference, and the set of inputs stays the same.
- No activity for a profile reset outside the harness workflow body (see the harness design).
- No version bump of the harness pin.

## Decisions

### The activity time is a column of the analysis row

Migration 11:

```sql
ALTER TABLE analyses ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0;
UPDATE analyses SET last_activity_at = updated_at;
CREATE INDEX idx_analyses_activity ON analyses(last_activity_at, id);
```

The backfill takes `updated_at`, because a run, a turn, or an ask of an old row left no SQLite record. The column appends after the foreign keys. A rebuild of `analyses` was rejected, because the children of the table cascade on a drop of the parent (see the comment of migration 10).

The column stays off the `Analysis` entity. Only the list reads it, thus `listAnalysisPage` gives `{ analysis, anchorPath, lastActivityAt }` for each row. `ANALYSIS_COLS` and the seven-field entity stay as they are.

`recordAnalysisActivity(id, atMs)` in `src/db/primary_mutation.ts` is the one raise: `UPDATE analyses SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?`. The row writes raise the column in their own statement, with the same `now` as `updated_at`: `renameAnalysis`, `updateAnalysisProject`, and the unlink of `deleteProject`. `insertAnalysis` writes `created_at`.

### One module holds the activity reactions

`src/modules/analysis/activity.ts` holds these exports:

- `noteAnalysisActivity(analysisId, atMs)` calls `recordAnalysisActivity` and logs a failure. Thus no caller fails on it.
- `watchAnalysisActivity()` subscribes to the bus and gives its stop. It takes `run.startedAtMs` of `prov.run_started`, `outcome.completedAtMs` of `prov.run_completed`, and `Date.now()` for `prov.input_added` and `prov.input_removed`.

`serve.ts` wires the watcher beside `watchInputDrift`, with a stop at the shutdown. The file has more than one caller: `serve.ts`, `routes/conversation.ts`, and `modules/harness/runtime.ts`. The `analysis` module imports no `harness` module, thus the import from `runtime.ts` makes no cycle.

The other sites call `noteAnalysisActivity` with `Date.now()`:

- `startChatTurn` in `routes/conversation.ts`, after the turn opens with no refusal. A refused turn ran nothing.
- `closeTurn`, after it records the end.
- The ask answer route, on the outcome `applied` only.

`activity.ts` also exports `notifyProfileSettledActivity(settlement)`, the realization of the harness notice. It calls `noteAnalysisActivity(settlement.analysisId, Date.parse(settlement.completedAt))` and gives `okAsync(undefined)`. `runtime.ts` binds it as `notifyDataProfileSettled` in the `dataProfile` deps, thus a test reaches the realization with no runtime.

The `MAX` in SQL makes an event that fires again harmless. A recovery fires a run event again with the same durable time. This obeys the rule of `event-bus` for a durable reaction to an event that fires again. The subscriber reads the `prov.*` family because the issue names those events. `run.observed` carries no start time or end time.

### The list composes grouped reads behind injectable options

`analysisCollectionRoutes(boot, opts)` takes the boot, and `app.ts` passes it. An `AnalysisListOpts` options object holds each read that a test replaces:

- the newest runs: `queryLatestRunsByAnalyses` of the harness
- the profiles: `queryDataProfileStatusByAnalyses` of the harness
- the live work: a new `countLiveDurableWorkByAnalysis(pool, analysisIds)` in `durable_work.ts`, which gives a `Map` from each id to its `LiveDurableWork`
- the pending asks: one `runtime.askGateway.pending()`, counted by analysis id over the ids of the page
- the paths: `pathsExistAsync(paths, DISK_READ_WIDTH)`
- the in-memory reads: `hasRunningTurn` and `profileWorkInFlight`

`countLiveDurableWork` and its grouped sibling share one SQL text for the liveness rule. Thus the busy gate and the list cannot disagree on what is live. The grouped form groups over `analysis_id = ANY($1::text[])`.

When `boot.runtime()` is `null`, the route makes no Postgres read. When it is ready, the 4 Postgres reads start together. Each read maps its failure to an "unreadable" value, logs it, and leaves its field `null`. `askGateway.pending()` rejects on a failure, thus the route wraps it with `ResultAsync.fromPromise`.

### One pure rule gives the busy reasons

`busy_gate.ts` gains `busyReasonsOf(facts)`. The facts are:

- `turn`: a boolean
- `profileDrive`: a boolean
- `profile`: `running`, `idle`, `unreadable`, or `unknown` when there is no runtime
- `liveRuns`: a count, `unreadable`, or `unknown` when there is no runtime

`workspaceBusyReasons` reads its facts for one analysis and calls the rule. The list takes the facts of each item from the grouped reads and calls the same rule. The order of the reasons stays the order of today: `chat_turn`, `data_profile`, `profile_state_unreadable`, and then `run` or `run_state_unreadable`. The profile ledger is not read for an analysis whose profile drive runs, the same as today.

### The wire types

`src/api/analyses.ts` gains these types:

- `AnalysisSort` = `"activity" | "created"`
- `AnalysisProfileSummary` = `{ status: DataProfileLifecycleStatus; profiledFiles: number | null; completedAt: string | null }`
- `AnalysisLatestRun` = `{ runId; status: RunStatus; planTitle: string | null; doneSteps; totalSteps; startedAt; completedAt: string | null }`

`AnalysisSummary` gains the six fields. Each field is required, and `null` carries an absence, because the item shape of the GUI must not depend on the phase. The `usage` field stays optional, because that is its contract today. `RunStatus` comes from `src/api/runs.ts`, and `DataProfileLifecycleStatus` comes from the harness contracts, as a type-only import.

`sort` parses with `z.enum(["activity", "created"])`. An absent or empty value selects `created`, the same as an empty `project`. A bad value gives 400 with `fieldErrors.sort`, the same as the `cwd` and `touch` checks of `GET {A}`. The page values keep their fallback rule, because the list rule names only `page` and `perPage`.

### One project by id

`getProjectWithCount(id)` in `primary_query.ts` reads the project and its correlated count in one statement, with `WHERE id = ?`, the same count subquery as `listProjectPage`. `GET /:projectId` in `routes/projects.ts` maps it to `ProjectSummary`, or to 404 `not_found` with the message "Project not found.", which is the message of the delete.

## Risks / Trade-offs

- [A row from before migration 11 shows `updated_at` as its activity, not its last run] → A new activity corrects it. No SQLite record of the old activity exists.
- [A crash between a profile stamp and the notice loses one activity time] → The next activity corrects the time. The harness design accepts this cost.
- [The project filter of the activity sort cannot use the activity index] → SQLite reads the analyses of one project through `idx_analyses_project` and sorts them. The size of one project bounds that sort.
- [`askGateway.pending()` reads each pending ask of each analysis] → Each pending ask holds a turn open, thus the set stays small. `GET {A}/asks` reads the same set today.

## Migration Plan

Migration 11 is forward-only and additive. An older binary ignores the new column. A new row from an older binary gets the default `0`. Its next activity in a current binary raises it.
