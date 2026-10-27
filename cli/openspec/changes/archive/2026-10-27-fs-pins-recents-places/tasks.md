# Tasks

## 1. The storage

- [x] 1.1 In `src/db/primary_migrations.ts`, add migration 13 with `picker_pins`, `recent_files`, and their indexes, as the `data-model-storage` delta and design D1 tell. Give it a comment block in the style of migration 12. Update the version pins and the index set of `src/db/primary_migrations.test.ts`. Add a version-13 test for the column order, the cascade of `recent_files`, and the unique constraint of each scope. Make sure that the test file passes.
- [x] 1.2 Add `src/types/picker.ts` with `PickerPin` and `RecentFile`, in the house field order, each with a JSDoc (design D1).
- [x] 1.3 In `src/db/primary_query.ts`, add `listPins` and `listRecentFiles`. In `src/db/primary_mutation.ts`, add `addPin` (design D3), `removePin`, and `recordRecentFile` (design D7), as the `data-model-db-access` delta tells. Add tests to `src/db/storage.test.ts` for the order of the pins, a second `addPin` that keeps the first pin, and a removal. Add tests for the move of `updated_at` on a second record, and for the exact scope of a read. Add a test for the cap of one scope that leaves a different scope. Make sure that the test file passes.

## 2. The pins and the recent files

- [x] 2.1 In `src/api/fs.ts`, add the wire types of the pins and the recent files: `PinView`, `PinList`, `AddPinRequest`, `DeletePinResponse`, `RecordRecentRequest`, `RecordRecentResponse`, and `RecentFiles`. Give each export and field a JSDoc.
- [x] 2.2 In `src/server/analysis_guard.ts`, export `guardAnalysisId(c, analysisId, opts)` and make `guardAnalysis` call it (design D6). Make sure that the guard tests of `src/server/routes/fs.test.ts` and `src/server/routes/analyses.test.ts` pass with no change.
- [x] 2.3 In `src/server/routes/fs.ts`, add the path helper of design D2, and make `absolutePathOf` use it. Add `GET /pins`, `POST /pins`, and `DELETE /pins/:id` as design D3 and D4 tell. Add `POST /recents` and `GET /recents` as design D5 to D8 tell. Lift the idle timeout on each GET. Update the JSDoc of `fsRoutes` to name the routes.
- [x] 2.4 Add tests to `src/server/routes/fs.test.ts` for each scenario of "The server gives the pins of the picker for the machine", "A client pins a path and removes a pin", "The server records a recent file of the picker", "The server bounds the recent files of each scope", and "The server gives the recent files of a scope". Also add tests for the scenarios "The recent-file read has no page", "A pin writes a row and no file", and "The picker routes are in the file system group". Include the 403 `forbidden` with `details.code` for a path that the server cannot read, and a label of 257 characters. Include a body `analysisId` that a different process locks, and a body `analysisId` whose analysis row is deleted before the write (design D6). Include an entry with `isInput` and `origin` from a replaced `artifactOrigins`. Include a recent file whose `lstat` fails with a code that is not an absence code. Make sure that the tests pass.

## 3. The places

- [x] 3.1 In `src/api/fs.ts`, add `PlaceSectionId`, `PlaceItem`, `PlaceSection`, and `Places` as design D9 tells. Give each export and field a JSDoc.
- [x] 3.2 In `src/server/routes/fs.ts`, add `listRuns` and `volumeRoots` to `FsRouteOpts`, with `queryRunsByAnalysis` and the platform roots of design D12 as the defaults. Add `GET /places` and its section reads as design D9 to D12 tell, with the caps of design D9. Lift the idle timeout.
- [x] 3.3 Add tests to `src/server/routes/fs.test.ts` for each scenario of "The server gives the places of the picker sidebar", "The places of an analysis", "The places of the machine", and "The server finds the mounted volumes of each platform". Use a replaced `homedir`, `listRuns`, and `volumeRoots`. A test must get each section with and without `analysisId`, and a missing Downloads folder must give no item. A test must show that the analysis section gives no run when the runtime is `null` and when `listRuns` fails. A test must show the caps of the inputs, the other analyses, and the drives with fixtures past each cap. A test must show that `listRuns` runs one time for a request. Make sure that the tests pass.

## 4. Verification

- [x] 4.1 Run `bun run format:file` on the changed files in `src/`. Then run `bun run typecheck`, `bun run lint`, and `bun run test` on each changed test file. Make sure that each command passes.
- [x] 4.2 Run `bun run test` one time for the full cli suite. Make sure that it passes. Result: 4322 pass, 1 fail. The one failure is `src/modules/libs/composition.test.ts`, which needs the Python `packaging` module that the host `python3` does not have (`composition.test.ts:1127-1131`). This change does not touch that test. After the review corrections, the 22 test files that import the changed modules gave 599 pass, 1 skip, 0 fail.
