# Tasks

Work in `cli/`. The working-copy harness is linked into `node_modules` through `bun run harness:local`. Run that script again only when `harness/` changes. Run only the test files of each task. Do not run the full suite or the full lint.

## 1. Obey the new harness contract in the fixtures

- [x] 1.1 In `src/tui/hooks/pauses.test.ts`, give the `part()` fixture a `pausedAt`. In `src/tui/hooks/conversation.test.ts`, give each `data-pause` frame `cause` and `pausedAt`. Give a frame in the state `running` also `endedAt` and `end` (`resume`, or `abort` for a turn that a stop ends). Give the frame of `src/server/routes/conversation.test.ts` a `pausedAt`. Run `bun run test` on the three files, and make sure that each test passes.
- [x] 1.2 In `src/server/routes/paused_work.test.ts`, change the fake `list` to take an optional analysis id. With no id, it gives each item. Run `bun run typecheck`, and make sure that it reports no error.

## 2. List the paused work of each analysis

- [x] 2.1 In `src/server/routes/paused_work.ts`, move the body of the `GET /` handler into one list function in the same file. The function takes the analysis id or no id. It calls `work.list` one time, keeps the work that waits, adds the remedy, and pages the items. The `GET {A}/paused-work` route calls it with its analysis id, and its tests stay green.
- [x] 2.2 Add `analysisNames` to `PausedWorkRouteOpts`, with the default `listAnalysisNames` of `src/db/primary_query.ts`. Add `pausedWorkCollectionRoutes(boot, opts)` with `GET /` behind `requireRuntime`. It calls the list function with no analysis id. Before the page, it drops each work whose analysis id is not in the map of `analysisNames`. A failed read gives 500 `internal_error` through `internalError`. Mount it at `/api/v1/paused-work` in `src/server/app.ts`, beside the attention mount. Update the doc comments of the route functions and of `src/api/paused_work.ts` to name the new route. Run `bun run format:file` on each changed source file. The tests of 2.3 show that this task is done.
- [x] 2.3 In `src/server/routes/paused_work.test.ts`, add tests of `GET /api/v1/paused-work`, mounted at that path. Assert that a turn of `a1` and a run of `a2` both show, each with its `analysisId`, with `total` 2. Assert that the waiter of the run is `{ kind: "step", stepId: "s1" }`, and that the fake got one `list` call with no id. Assert that a server with no paused work and one run that runs gives `{pausedWork: [], total: 0, page: 0, perPage: 100, hasMore: false}`. Assert that the work of an analysis with no row is absent, also with `perPage=1` when that work comes first in the list. Assert that the remedy rule holds. Assert that a failed `list` and a failed `analysisNames` give 500 `internal_error`. Assert that no runtime gives 503 `unavailable`. Run the file, and make sure that each test passes.
- [x] 2.4 In the `GET {A}/paused-work` tests, assert that a run with the waiting steps `s1` and `s2` gives the waiter and the `pausedAt` of each wait. Assert that a waiting workflow with no waiter gives no `waiter` field. Run the file, and make sure that each test passes.

## 3. Verify

- [x] 3.1 Run `bun run typecheck`, and make sure that it reports no error.
