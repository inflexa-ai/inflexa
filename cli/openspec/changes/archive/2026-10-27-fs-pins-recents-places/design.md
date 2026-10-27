# Design

## Context

- `fsRoutes(boot, opts)` (`src/server/routes/fs.ts:393-492`) gives `/home`, `/list`, `/read`, and `/preview`. `app.ts:60` mounts it at `/api/v1/fs`. `analysisQueryGuard` is its first middleware (`fs.ts:398`), thus each new route gets the guard of a query `analysisId`.
- `absolutePathOf(c)` (`fs.ts:159-172`) reads the query value `path`. `readErrorResponse` (`fs.ts:370-385`) maps a folder read failure to 404, 400, or 403.
- `entryView(entry, list, opts)` (`fs.ts:88-112`) builds a `FolderEntryView` without `origin` from a `FolderEntry`, in a `PQueue` of width `ENTRY_READ_WIDTH = 16` (`fs.ts:61`, `:450`). `readOrigins` (`fs.ts:119-146`) sends one ledger read for the entries inside the workspace, and gives an empty map on a failure.
- `listAnalysisInputPage(analysisId, { limit, offset })` (`src/db/primary_query.ts:318-326`) gives a page of the inputs and the count of all of them. `inputAbsolutePaths` (`src/modules/analysis/input.ts:108-133`) gives the canonical path of each input, with one anchor resolution for each anchor.
- `listAnalysisPage` (`primary_query.ts:263-283`) gives each analysis with the cached path of its anchor, in one statement. `defaultOutputSubdir(slug)` (`src/modules/analysis/output.ts:24-26`) is the workspace path under the anchor.
- `locateWorkspaceReadRoot(analysisId)` (`src/modules/analysis/boundary.ts:135-139`) gives the canonical workspace root, `null` when the folder cannot be located, or a `DbError`.
- The harness exports `queryRunsByAnalysis(pool, analysisId, { limit })` (`harness/src/state/runs.ts:364`), newest start first. The run folder `runs/<runId>` holds a folder for each step that wrote, plus `synthesis/` and `synthesis.json` (`harness/src/workspace/paths.ts:340-395`).
- `guardAnalysis` (`src/server/analysis_guard.ts:45-59`) does the 404 and lock steps, and it is private to the middleware.
- `analysis_inputs` keeps one row for each path of a scope with a partial unique index pair (`src/db/primary_migrations.ts:48-66`). The reason is that SQLite treats each `NULL` as distinct in a `UNIQUE` key. The latest migration is version 12.
- No cli client and no TUI code calls a route under `/api/v1/fs`.

## Goals / Non-Goals

**Goals:**

- One call gives the whole sidebar of the picker, the Inputs list included.
- Each read that grows with the machine has a fixed bound, and each disk read runs in a queue of fixed width.
- No query or ledger read runs in a loop over rows.

**Non-Goals:**

- No new route for the inputs. The `inputs` item of `fs/places` carries the entries.
- No harness change.
- No pin that follows a moved folder. A pin stores a canonical path, and a pin of a moved folder is lost.
- No change to the TUI or to a cli fetcher.
- No route that removes one recent file.

## Decisions

### D1. Tables, types, and the migration

Migration 13 adds `picker_pins` and `recent_files`, as the `data-model-storage` delta states. `recent_files.analysis_id` references `analyses(id)` with `ON DELETE CASCADE`, so a deleted analysis takes its recent files. `uq_picker_pins_path` is a unique index on `path`, as #720 asks.

`src/types/picker.ts` holds the row types `PickerPin` and `RecentFile`, in the house field order. `primary_migrations.test.ts` pins the version list and the index set, thus the test changes with the migration.

`addPin` and `recordRecentFile` mint the id with `randomUUIDv7()` and the times inline, as `createProject` does (`src/db/primary_mutation.ts:16-38`). The caller gives no row, because the write decides if a row is new.

### D2. A pin and a recent file store the real path

`POST /pins` and `POST /recents` read the body with zod. The path checks run in one helper that `absolutePathOf` also uses: absolute, no NUL byte, and `resolve` to remove each `.` and `..`. Then one `realpath` gives the stored path, and one `stat` of the real path gives `isDir`. `ENOENT`, `ENOTDIR`, and `ELOOP` give 404 `not_found`. Each other failure gives 403 `forbidden` with `details.code`. Thus two spellings of one folder share one pin and one recent row.

### D3. A second pin keeps the first pin

`addPin` mints the id and the times, and runs one `INSERT … ON CONFLICT(path) DO UPDATE SET path = excluded.path RETURNING …`. The update changes no value, and `RETURNING` gives the stored row. When the returned id is not the minted id, the pin existed, and the route answers 200 with it. A new pin gives 201.

Alternative: 409 `conflict`, the rule of a duplicate project name (`src/server/routes/projects.ts:59-62`). A pin is a mark, as the seen mark of a run is (`recordRunSeen`, `src/db/primary_mutation.ts:709-715`). A toggle in two tabs then needs no error path. Rejected.

### D4. The resolution of a pin

`GET /pins` reads one page with `listPins`, and runs one `realpath` for each pin of the page in the queue of fixed width. A failure of any kind gives `absolutePath: null`, because the server cannot locate the path. The route never fails on a pin. `label` keeps `null` when the person gave no label.

### D5. The scope of a recent file is exact

A recent file belongs to one analysis, or to the machine scope (`analysis_id IS NULL`). The read selects `WHERE analysis_id IS ?`, thus the read of the machine scope does not show the files of an analysis. This obeys the unique key `(path, analysis_id)` of #721.

Alternative: the read without `analysisId` merges each scope. Then one path can show two times, and the key of the row does not name the list. Rejected.

### D6. The body `analysisId` of a recent file gets the guard

#721 puts `analysisId` in the body of the post. `analysis_guard.ts` exports `guardAnalysisId(c, analysisId, opts)`, which gives the 404 or 409 response, or `null`. `guardAnalysis` calls it, thus the middleware and the post share one set of steps. The post calls it for a non-empty body value, before the write. A delete of the analysis between the guard and the write trips the foreign key. The route maps that `constraint_violation` of the kind `foreign_key` to 404 `not_found`.

### D7. The cap of the recent files is for each scope

`RECENT_FILES_CAP = 100`. `recordRecentFile` runs in `withTransaction`: an `UPDATE … SET updated_at = ?, is_dir = ? WHERE path = ? AND analysis_id IS ?`, then an `INSERT` when no row changed, then one `DELETE` of the rows of the scope that are not in the newest `cap`. The update first keeps one statement shape for both scopes, because the target of `ON CONFLICT` must name one partial index.

The table then holds at most 100 rows for each analysis and 100 for the machine. A busy analysis cannot push out the recent files of a different analysis.

Alternative: one cap for the whole table. Rejected for that reason.

### D8. The recent-file read drops a path with no file and keeps its row

`GET /recents` reads the newest `RECENT_FILES_CAP` rows of the scope in one statement. It does an `lstat` of each row in the queue, in order, and stops when it has `limit` entries. An `lstat` with an absence code of `ABSENT_CODES` (`ENOENT`, `ENOTDIR`, or `ELOOP`, `src/modules/analysis/boundary.ts:94`) drops the row from the response. The read does not delete the row. A loop of links in a parent folder leaves no way to the path, thus it counts as no entry. Each other failure keeps the entry, with the type from `is_dir` and `null` facts, as the folder list keeps an entry that it cannot read.

The entry comes from `entryView`, with the list context of the request: one read of the inputs and the workspace root with `analysisId`, and one `readOrigins` for the entries. `limit` is `parseCount(limit, 20, RECENT_FILES_CAP)`.

A `GET` does not change the data. A path can be absent for a short time, for example on a volume that is not mounted. If the read deletes the row, the person loses that recent file. Thus the row stays, and it costs an `lstat` at each read and a place under the cap. Only the cap of a post removes a row. #721 names `clearRecentFile`, but no route calls it, thus this change does not add it.

### D9. The places response

```ts
type PlaceSectionId = "analysis" | "favorites" | "locations" | "otherAnalyses" | "drives";
type PlaceItem =
    | { kind: "workspace" | "run" | "step" | "home" | "desktop" | "documents" | "downloads" | "analysis" | "drive"; label: string; path: string }
    | { kind: "pin"; label: string; path: string; pinId: string; lost: boolean }
    | { kind: "inputs"; label: string; count: number; entries: FolderEntryView[] };
type Places = { sections: { id: PlaceSectionId; items: PlaceItem[] }[] };
```

The `label` is data: the name of an analysis, a run id, a folder name, or the label of a pin. The label of the `inputs` item is `Inputs`, and Flamme takes its word from `kind`. The sections read in parallel. Each section reads the disk in its own queue of width `ENTRY_READ_WIDTH`.

The bounds are constants beside the route: `PLACE_INPUTS_CAP = 200`, `PLACE_RUNS_CAP = 10`, `PLACE_STEPS_CAP = 50`, `PLACE_PINS_CAP = 50`, `PLACE_ANALYSES_CAP = 20`, and `PLACE_DRIVES_CAP = 20`.

### D10. The places of an analysis

- `locateWorkspaceReadRoot(analysisId)` gives the root one time. A `DbError` gives 500. The `workspace` item needs a `stat` that shows a folder.
- `listAnalysisInputPage(analysisId, { limit: PLACE_INPUTS_CAP, offset: 0 })` gives the inputs and `count` in one statement. `inputAbsolutePaths` locates them. An `lstat` of each located path drops an absent input. `entryView` builds each entry with `isInput` true, and one `readOrigins` gives the origins when the runtime is ready.
- With a ready runtime, `opts.listRuns(pool, analysisId, { limit: PLACE_RUNS_CAP })` is one ledger read. For each run, `readFolder(<root>/runs/<runId>, false)` runs in the queue. An absent run folder drops the run. The step items are the `folder` entries of the read, in its order, at most `PLACE_STEPS_CAP`. A failed ledger read logs a warning and gives no run.

The `synthesis` folder shows as a step. The ledger also holds a step row with the id `synthesis` (`SYNTHESIS_STEP_ID`, `harness/src/workspace/paths.ts:385`), and the folder holds the outputs of that phase. A filter would copy a harness constant into the cli.

Alternative: the steps from the step ledger. The harness reads the steps of one run per statement (`harness/src/state/step-executions.ts:226`), thus 10 runs need 10 reads, or a new harness read. Rejected, with the user.

### D11. The places of the machine

- `favorites`: `listPins({ limit: PLACE_PINS_CAP, offset: 0 })`, then the resolution of D4. A lost pin keeps its stored path.
- `locations`: `opts.homedir()` through `canonicalPathAsync`, then one `stat` of `Desktop`, `Documents`, and `Downloads` in the home folder. Only a folder gives an item.
- `otherAnalyses`: `listAnalysisPage({ projectId: null, sort: "activity", limit: PLACE_ANALYSES_CAP + 1, offset: 0 })`. The route drops the analysis of `analysisId`, keeps at most `PLACE_ANALYSES_CAP`, and joins the cached anchor path with `defaultOutputSubdir(slug)`. A `stat` in the queue keeps the existing folders, and `canonicalPathAsync` gives the path. An analysis with no cached path gives no item.
- `drives`: D12.

The cached anchor path can be out of date after a move. Then the item is absent until the anchor heals. An anchor resolution for each analysis is the alternative: it costs a query and a bounded search for each row. Rejected.

### D12. The mounted volumes are an option

`FsRouteOpts` gets `volumeRoots: () => readonly VolumeRoot[]`, with `VolumeRoot = { path: string; kind: "parent" | "volume" }`. A `parent` root is a folder whose entries are the candidates. A `volume` root is one candidate itself. A test gives temporary folders. The default reads `process.platform`:

- `darwin`: the `parent` root `/Volumes`.
- `linux`: the `parent` roots `/media/<user>`, `/run/media/<user>`, and `/mnt`. `<user>` is `userInfo().username`.
- `win32`: the `volume` roots `A:\` to `Z:\`.

The server lists the entries of each `parent` root with `readFolder(root, false)`. A candidate gives an item when its `realpath` is a folder and is not `/`. The label is the name of the entry, or the drive letter with its colon for a `volume` root. Thus the link `Macintosh HD` to `/` gives no item. The items sort by name, and the first `PLACE_DRIVES_CAP` stay. An absent root gives no item and no error.

### D13. The code stays in the files of its callers

The route code, the place reads, and the volume roots stay in `src/server/routes/fs.ts`, because the routes are their only caller. The wire types go in `src/api/fs.ts`. The db functions go in `primary_query.ts` and `primary_mutation.ts`. `opts.listRuns` defaults to `queryRunsByAnalysis`, and a test replaces it, because the real read needs Postgres.

## Risks / Trade-offs

- [One read of the places can stat about 300 paths] → The caps of D9 bound the count. Each read runs in a queue of width 16, off the event loop, and the route lifts the idle timeout. A hung mount holds one slot.
- [The recent-file read writes the database] → It deletes only the row of a path at which no entry exists now. The person posts the file again at the next open.
- [An unmounted volume gives `ENOENT`, thus its recent files go] → The recent list shows the files that exist now. A pin of the volume stays, and it shows as lost.
- [The `synthesis` folder shows as a step] → It is a real folder of the run with outputs. D10 gives the reason.
- [A drive letter that is a hung network share on Windows] → Each `realpath` runs in the queue, thus it holds one slot only.

## Migration Plan

Migration 13 adds two tables and their indexes, and it changes no old row. An older binary ignores the tables. No rollback step is necessary.
