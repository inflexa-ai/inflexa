# Tasks

## 1. The shared parts

- [x] 1.1 Run `bun run harness:local`, after the harness change `fs-list-and-preview` adds `queryArtifactOrigins`. Make sure that `import { queryArtifactOrigins } from "@inflexa-ai/harness"` resolves in a `bun run typecheck`.
- [x] 1.2 In `src/api/fs.ts`, rename `FolderEntryKind` to `FolderEntryType`. In `FolderEntryView`, rename `kind` to `type`, and add `kind: FileKind | null`, `itemCount`, `isInput`, and `origin` with the new type `FileOrigin` (design D1). Add `FILE_KINDS`, derive `FileKind` from it, and add the `FilePreview` union with its member types (design D9, D11). Give each new export and field a JSDoc. Make sure that `src/modules/fs/file_kind.ts` still typechecks with no change to its map.
- [x] 1.3 In `src/lib/folder_listing.ts`, add `scanFolder` and `countFolderEntries`, and export `compareEntries` (design D3). Add tests to `src/lib/folder_listing.test.ts` for the count with and without the hidden entries, and for the entries that `visit` gets. Add tests for a folder that does not exist, and for a path that is a file. Make sure that the tests pass.
- [x] 1.4 In `src/modules/analysis/boundary.ts`, export `contains`, and move `locateRoot` of `src/server/routes/artifacts.ts` there as `locateWorkspaceReadRoot` (design D5, D6, D12). Make the artifact list import it. Make sure that `src/server/routes/artifacts.test.ts` and `src/modules/analysis/boundary.test.ts` pass with no change.
- [x] 1.5 In `src/server/routes/files.ts`, move the real-path switch, the open, and `openFailure` of `serveFile` into the export `openRealPath` (design D7). Make `serveFile` call it. Make sure that `src/server/routes/files.test.ts` and `src/server/routes/report_pages.test.ts` pass with no change.

## 2. The folder list

- [x] 2.1 Change `fsRoutes` to `fsRoutes(boot, opts)`, and add `artifactOrigins` to `FsRouteOpts` with `queryArtifactOrigins` as the default (design D6). Make `src/server/app.ts` pass `deps.boot`. Update the JSDoc of `fsRoutes`, which says that the routes use no harness runtime. Make sure that `src/server/app.test.ts` passes.
- [x] 2.2 In `GET /list`, read the facts of each entry of the page in one `PQueue` of the width `ENTRY_READ_WIDTH` (design D2). Give `type`, `kind`, and `itemCount` as design D1 and D3 tell. Read `namePrefix` as design D4 tells.
- [x] 2.3 In `GET /list`, give `isInput` and `origin` as design D5 and D6 tell. Read the inputs and the workspace root one time for each request. Send at most one `artifactOrigins` call for each page, in parallel with the queue. Degrade to `null` origins when the runtime is `null` or the read fails, and log the failure.
- [x] 2.4 Update `src/server/routes/fs.test.ts` for `type` and the exact key set. Add tests for each new scenario of "The server gives the home folder and the entries of a folder". The tests must cover each new field with and without `analysisId`, `namePrefix` and its hidden rule, and an unreadable child folder. A test must count the `artifactOrigins` calls with a replaced read, and show one call with the relative paths of the page. A test must show no call for a folder outside the workspace and before the runtime is ready. A test must show `null` origins when the read fails. Make sure that the tests pass.

## 3. The preview route

- [x] 3.1 Add `previewBytes` to `FsRouteOpts`, 64 KiB in production. Add `GET /preview` to `fsRoutes` as design D8, D9, and D10 tell. Keep its helpers in `src/server/routes/fs.ts` (design D12). Update the JSDoc of `fsRoutes` to name the route.
- [x] 3.2 Add tests to `src/server/routes/fs.test.ts` for each scenario of "The server gives a preview of a file or a folder" and of "The preview route refuses a bad request with a named error". A test must get each member: `table` with a quoted header and a full file, `table` with a cut head, `text`, `figure`, `folder`, and `card`. A test must show that a binary file gives `card`, by a NUL byte and by a byte sequence that is not UTF-8. A test must show that a symbolic link at the last part of the real path gives 403, with a replaced `open` as `files.test.ts` does. A test must show 403 for a folder whose `lstat` after the read does not match the opened handle. Use a replaced `open` that opens a different folder. A test must show a `rowCount` with a quoted line end. A test must show that a link to a file gives the preview of its target. A test must show that a head with no line end gives `text` and not `table`. Make sure that the tests pass.

## 4. Verification

- [x] 4.1 Run `bun run format:file` on the changed files in `src/`. Then run `bun run typecheck`, `bun run lint`, and `bun run test` on each changed test file. Make sure that each command passes.
- [x] 4.2 The coordinator runs `bun run test` one time for the full cli suite at the end of the work. Make sure that it passes.
