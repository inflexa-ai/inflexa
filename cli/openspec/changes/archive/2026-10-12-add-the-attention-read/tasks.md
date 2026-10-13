# Tasks

## 1. The harness dependency

- [x] 1.1 Finish the harness change `add-the-attention-read`. Then run `bun run harness:local` in `cli/`, and make sure that the cli typecheck sees `queryRunProgressByRuns`, `queryRunsEndedSince`, and `listRecentThreads`.

## 2. The seen state in SQLite

- [x] 2.1 Add migration 12 to `src/db/primary_migrations.ts`: `run_seen_marks`, `idx_run_seen_marks_analysis`, `run_seen_baseline`, and its one row. Update the version lists and the index set of `src/db/primary_migrations.test.ts`. Add a test that the baseline row holds the time of the migration to the millisecond.
- [x] 2.2 Add `recordRunSeen` to `src/db/primary_mutation.ts`, and `getRunSeenState` and `listAnalysisNames` to `src/db/primary_query.ts`. Do db tests of these cases:
  - a second mark keeps the first time and returns 0
  - the delete of an analysis removes its marks
  - an absent baseline row gives `since` `null`
  - the names skip an unknown id, and an empty list sends no query

## 3. The live runs and the turn registry

- [x] 3.1 Add `listLiveRunIds(pool, limit)` to `src/server/durable_work.ts` over the unchanged `RUN_IS_LIVE` text, and name the new reader in the doc of the constant. Make sure in `src/server/durable_work.test.ts` that it sends one query with the `RUN_IS_LIVE` predicate. It must bind the limit and the live statuses.
- [x] 3.2 Add `runningTurnsByThread()` to `src/server/turns.ts`. Make sure in `src/server/turns.test.ts` that it gives the newest running turn of a thread, with the turn id as the tie rule. A thread with ended turns only has no entry.

## 4. The thread fields

- [x] 4.1 Add `runningTurnId` and `pendingAsks` to `ThreadSummary` in `src/api/conversation.ts`, and pass them through `toThreadSummary`. Update each fixture that builds a `ThreadSummary`, and make sure that `bun run typecheck` passes.
- [x] 4.2 Fill the two fields in `GET {A}/threads`, `GET {T}`, `PATCH {T}`, and `POST {T}/restore` from one `askGateway.pending()` call and the registry. Add route tests to `src/server/routes/conversation.test.ts`:
  - a thread with a running turn and an open ask
  - an idle thread
  - a rejected ask read gives 500, and `PATCH {T}` then changes no title

## 5. The seen route

- [x] 5.1 Add `RunSeenResponse` to `src/api/runs.ts` and `POST /run/:runId/seen` to `src/server/routes/runs.ts`. Add route tests to `src/server/routes/runs.test.ts` with `freshDb()`:
  - a terminal run gives 200 and a mark
  - a second mark gives 200
  - a running run gives 409 and no mark
  - a run of a different analysis and an unknown run give 404

## 6. The attention read

- [x] 6.1 Add `src/api/attention.ts` with the wire types. Add `attentionRoutes` with `AttentionRouteOpts` in `src/server/routes/attention.ts`, and mount it at `/api/v1/attention` in `src/server/app.ts`.
- [x] 6.2 Add `src/server/routes/attention.test.ts` for these cases:
  - an open ask in one analysis and a live run in a different analysis give both, with the names
  - an ask whose thread has no running turn is stale, an ask with a running turn is not, and an ask with no thread is stale
  - a seen run and a run that ended before the baseline are absent from `unseenRuns`, and the read gets the marks as its skip list
  - an absent baseline row gives an empty `unseenRuns` and no ended-run read
  - a run whose progress entry is terminal is absent from `activeRuns`
  - `recentThreads` asks for the `conversation` type, and its items carry `runningTurnId`, `pendingAsks`, and `analysisName`
  - after `POST {A}/run/:runId/seen`, the run leaves `unseenRuns`
  - an item of an analysis with no SQLite row is absent
  - `limit` gives 10 by default and for `0`, `-1`, `2.5`, and `abc`, and a larger value than 200 gives 200
  - the phase `starting` gives 503
  - a failed read gives 500
  - no live run sends no progress read
  - the count of each read is the same for 1 analysis and for 20 analyses

## 7. Checks

- [x] 7.1 Run `bun run format:file` on the changed files in `src/`. Then run `bun run lint`, `bun run typecheck`, and the changed test files. Make sure that each passes.
- [x] 7.2 Run the full cli suite (`bun run test`) one time. Make sure that only the known environment failure remains: `the composed layout stays in parity with the provisioner layout` in `src/modules/libs/composition.test.ts`.
