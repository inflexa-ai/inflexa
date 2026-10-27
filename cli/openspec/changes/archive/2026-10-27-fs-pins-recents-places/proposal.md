# Proposal

## Why

The sidebar of the file picker of Flamme (inflexa-ai/himmel#111) shows the places of the machine, the favorite folders, and the recent files. No route gives them today. Three GitHub issues name the gaps:

- #720: a person can pin a folder in the picker. A pin is machine-wide (decision D5), thus a pin of one analysis shows in each other analysis. No table, route, or setting holds a pin.
- #721: the picker shows a Recent list of the files that the person opened or previewed (decision D4). The list lives in the SQLite store of the CLI, thus the TUI and Flamme can show one list. No code records a file open.
- #743: the sidebar reads live places and never a fixed folder list (decision 6). Without one route, the client must call `fs/home`, the inputs, the runs, the analyses, and the pins, and then join them.

## What Changes

- A migration adds the SQLite tables `picker_pins` and `recent_files`, with their indexes.
- New access functions: `listPins`, `addPin`, and `removePin` for the pins, and `listRecentFiles` and `recordRecentFile` for the recent files.
- New routes in the file system group:
  - `GET /api/v1/fs/pins`, `POST /api/v1/fs/pins`, and `DELETE /api/v1/fs/pins/:id`. A pin of a path that the server cannot locate now comes back with `absolutePath: null`, and the route does not fail.
  - `POST /api/v1/fs/recents` with the body `{path, analysisId?}`, and `GET /api/v1/fs/recents?analysisId=&limit=`. The read gives `FolderEntryView` entries, newest first, and it drops a path that has no file now. Each scope keeps a fixed count of rows.
  - `GET /api/v1/fs/places?analysisId=`. It gives the sections in a fixed order: this analysis (only with `analysisId`), the favorites, the locations, the other analyses, and the drives. Each item has a `kind`, a `label`, and an absolute path. The `inputs` item has no path: it carries the entries of the located inputs inline, with `count` as the total.
- The rule that the file system routes do not write to the disk gets two exceptions: the rows of the pins and of the recent files.
- The recent-file read is a named exception to the list shape, because it takes `limit` and no page.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the file system group gets the pins, the recent files, and the places. The file system routes can write the rows of the pins and of the recent files. The recent-file read takes `limit` in place of the page values.
- `data-model-storage`: the schema gets the tables `picker_pins` and `recent_files`, and the lookup indexes get their indexes.
- `data-model-db-access`: the db layer gets the functions of the pins and of the recent files.

## Impact

- cli code: `src/db/primary_migrations.ts`, `src/db/primary_query.ts`, `src/db/primary_mutation.ts`, `src/types/`, `src/api/fs.ts`, `src/server/routes/fs.ts`, `src/server/analysis_guard.ts`, and the tests of these files.
- No harness change. The places route reads the run ledger through the existing `queryRunsByAnalysis` of `@inflexa-ai/harness`.
- No cli client and no TUI code calls a route under `/api/v1/fs`. Thus no fetcher and no TUI code changes.
- The callers of Flamme come in inflexa-ai/himmel#104 and #143, in a different repository.
