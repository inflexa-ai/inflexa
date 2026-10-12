# Tasks

## 1. The harness dependency

- [x] 1.1 Finish the harness change `summarize-the-analysis-list`. Then run `bun run build` in `harness/`, and make sure that the linked `node_modules/@inflexa-ai/harness` gives the new names to the cli typecheck.

## 2. The activity column

- [x] 2.1 Add migration 11 to `src/db/primary_migrations.ts`: the column, the backfill from `updated_at`, and `idx_analyses_activity`. Update the version lists and the index set of `src/db/primary_migrations.test.ts`. Add a test that a row from before the migration gets its `updated_at` as its activity time.
- [x] 2.2 Write `last_activity_at` in `insertAnalysis`. Raise it in `renameAnalysis`, `updateAnalysisProject`, and the unlink of `deleteProject`. Add `recordAnalysisActivity(id, atMs)`. Make sure with db tests that the time never goes lower, that `updated_at` stays, and that an unknown id changes 0 rows.
- [x] 2.3 Give `listAnalysisPage` the `sort` value and the `lastActivityAt` of each row. Add `getProjectWithCount(id)`. Make sure with db tests that the activity order and the id tie-break are correct, and that a project name does not match.

## 3. The activity reactions

- [x] 3.1 Add `src/modules/analysis/activity.ts` with `noteAnalysisActivity` and `watchAnalysisActivity`. Wire the watcher in `src/server/serve.ts` with a stop at the shutdown. Do a test with `Bus.emit` of each of the four events, and of a run event that fires again with the same time.
- [x] 3.2 Note the activity at the open and the end of a chat turn, and at an applied ask answer, in `src/server/routes/conversation.ts`. Make sure with route tests that a refused turn and an answer that is not applied change nothing.
- [x] 3.3 Add `notifyProfileSettledActivity` to `src/modules/analysis/activity.ts`, and bind it as `notifyDataProfileSettled` in the `dataProfile` deps of `src/modules/harness/runtime.ts`. Make sure with a test that a settlement raises the activity to its completion time.

## 4. The busy rule and the live work

- [x] 4.1 Add `busyReasonsOf` to `src/server/busy_gate.ts`, and make `workspaceBusyReasons` use it. Make sure that the tests of `src/server/busy_gate.test.ts` pass with no change of the expected reasons.
- [x] 4.2 Add `countLiveDurableWorkByAnalysis(pool, analysisIds)` to `src/server/durable_work.ts`, with the liveness SQL shared with `countLiveDurableWork`. Make sure in `src/server/durable_work.test.ts` that it sends one query and maps the rows by analysis id.

## 5. The list and the project routes

- [x] 5.1 Add `AnalysisSort`, `AnalysisProfileSummary`, `AnalysisLatestRun`, and the six fields of `AnalysisSummary` to `src/api/analyses.ts`. Correct the order text of `AnalysisList`. Update each fixture that builds an `AnalysisSummary`, and make sure that `bun run typecheck` passes.
- [x] 5.2 Give `analysisCollectionRoutes` the boot and an `AnalysisListOpts` options object, and pass the boot in `src/server/app.ts`. Build the summary of each item from the grouped reads and `busyReasonsOf`. Parse `sort`.
- [x] 5.3 Add the route tests of the list to `src/server/routes/analyses.test.ts`:
  - the activity sort and the created sort
  - a bad sort value gives 400
  - the phase `starting` gives `null` Postgres fields
  - a failed grouped read gives `null` and the unreadable busy reasons
  - a rejected `askGateway.pending()` gives 200 with `pendingAsks` `null`
  - an empty `sort` selects the created order
  - `folderPresent` for a present and a missing path
  - the count of the Postgres reads is the same for a page of 1 and a page of 20
- [x] 5.4 Add `GET /:projectId` to `src/server/routes/projects.ts`. Make sure in `src/server/routes/projects.test.ts` that a known id gives its count, and that an unknown id and a project name each give 404.

## 6. Checks

- [x] 6.1 Run `bun run format:file` on the changed files in `src/`. Then run `bun run lint`, `bun run typecheck`, and the changed test files. Make sure that each passes.
- [x] 6.2 Run the full cli suite (`bun run test`) one time. Make sure that only the known environment failure remains: `the composed layout stays in parity with the provisioner layout` in `src/modules/libs/composition.test.ts`.
