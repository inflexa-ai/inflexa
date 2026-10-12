# Summarize each analysis of the list, sort it by activity, and read one project

## Why

A client that lists analyses must show the state of each one: the data profile, the newest run, the open asks, and the busy reasons. Today each of those is a different route for each analysis, thus a list of N analyses costs 1 + 4N requests (#644). No sort shows the newest work first. No route reads one project by id, thus a client finds a project only through the pages of the list.

## What Changes

- `GET /api/v1/analyses` gives these fields on each item:
  - `lastActivityAt`
  - `folderPresent`
  - `profile`
  - `latestRun`
  - `pendingAsks`
  - `busy`
- `GET /api/v1/analyses` takes `sort=activity|created`. The default is `created`, the current order.
- The list reads a fixed count of statements for each page. The Postgres reads are grouped harness reads, one `askGateway.pending()` call, and one grouped live-work read. Until the phase is `ready`, the Postgres fields are `null`.
- SQLite keeps `last_activity_at` on each analysis row, with an index. The server raises it at each activity:
  - a row change
  - the open and the end of a turn
  - an applied ask answer
  - an input change
  - a run start and a run end, from the bus
  - a profile settle, from the new harness notice
- `GET /api/v1/projects/:projectId` gives one project with its analysis count, or 404 `not_found`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the list of analyses gives a summary of each analysis and a sort, and the server records the activity of each analysis.
- `projects`: a route reads one project by id.
- `data-model-db-access`: the analysis writes raise the activity time, and the paged reads give the activity order and one project by id.
- `data-model-storage`: the `analyses` table gains `last_activity_at`, and the index list is complete again.

## Impact

- `src/server/routes/analyses.ts`, `src/server/routes/projects.ts`, `src/server/routes/conversation.ts`, `src/server/busy_gate.ts`, `src/server/durable_work.ts`, `src/server/serve.ts`, and `src/server/app.ts`.
- `src/api/analyses.ts`. The project route reuses `ProjectSummary` of `src/api/projects.ts` with no change.
- `src/db/primary_migrations.ts` (migration 11), `src/db/primary_query.ts`, and `src/db/primary_mutation.ts`.
- `src/modules/analysis/activity.ts` (new) holds the activity reactions. `src/modules/harness/runtime.ts` binds the settle notice of the harness.
- The cli needs the harness change `summarize-the-analysis-list`: the grouped reads and the settle notice.
