# Tasks

## 1. The kind map

- [x] 1.1 Add `FileKind` to `src/api/fs.ts` with the lower-case values of design D7, and a JSDoc block. Make sure that `bun run typecheck` passes.
- [x] 1.2 Add `src/modules/fs/file_kind.ts` with `fileKindOf(name: string): FileKind | null` (design D7). Put in it the one comment about the folder classifier of the harness. Make sure that `src/modules/fs/file_kind.test.ts` covers each scenario of "The file system routes take the kind of a file from its extension". It also covers each extension of each kind, and a path with a dot in a folder name. Make sure that it passes.

## 2. The `analysisId` guard and the home folder

- [x] 2.1 Add `analysisQueryGuard` to `src/server/analysis_guard.ts`, and make it share one private function with `analysisGuard` (design D2). Make sure that `analysisGuard` keeps its behavior: the `app.test.ts` tests of an unknown analysis and of the lock pass with no change.
- [x] 2.2 Change `FsRouteOpts` and `DEFAULT_FS_ROUTE_OPTS` as design D3 tells, and register `analysisQueryGuard` first in `fsRoutes`. Make sure that `src/server/routes/fs.test.ts` covers each scenario of "A file system route guards the analysis of its query value":
  - 404 for an unknown id on `/list`
  - 409 `locked` with `details.holderPid` from a replaced `acquireLock`
  - no lock call for an absent value and for an empty value
  - one lock call for a known analysis
- [x] 2.3 Add `homedir` to `FsRouteOpts` (design D3), and make `/home` give `canonicalPathAsync(opts.homedir())` (design D5). Make sure that `fs.test.ts` covers the scenarios "The home folder" and "A home folder behind a link". The second test gives a replaced `homedir` that names a link to a folder. Make sure that the file passes.

## 3. The read route

- [x] 3.1 Add the function of design D8 to `fs.ts`, and make `/list` call it. Add `GET /read` to `fsRoutes` as design D1 tells: the function of D8, the validation of `download`, `holdConnection`, and `serveFile` with `"unlimited"` in place of a list of roots. Add `"unlimited"` to `classifyRealPath` and `serveFile`, and cover it in `boundary.test.ts`. Move the response options of the read route and `notAFile` from `files.ts` to `fs.ts` (design D4).
- [x] 3.2 Remove `fileRoutes`, `locateTarget`, and the mount at `src/server/app.ts:76`. Remove `inputReadRoots` from `src/modules/analysis/boundary.ts` and its tests from `boundary.test.ts`. Make the text of `FORBIDDEN_MESSAGE` neutral, and make the JSDoc of `serveFile` name its two callers (design D4). Make sure that `bun run typecheck` passes and that `rg "fileRoutes|inputReadRoots|/files\?path" src --glob '!*.test.ts'` finds nothing.
- [x] 3.3 Change `src/server/routes/files.test.ts` to drive `GET /read` of `fsRoutes(opts)` with absolute paths. Remove the tests of the roots of the form of a path. Make sure that the file covers each scenario of "The server gives the bytes of a file at an absolute path" and of "The read route refuses a bad request with a named error". Include these cases:
  - a workspace file, a file of a declared input, and a file outside each analysis
  - a link to a file, a path with a `..` segment, and a relative path
  - the sandbox header for HTML, XHTML, SVG, and XML

  Keep the tests of the headers, the tag, the range, the stream, and the open flags. Make sure that the file passes.
- [x] 3.4 Change the file route tests of `src/server/app.test.ts:92-135` to `GET /api/v1/fs/read?path=<absolute path>`. Make sure that they cover the session cookie, the bearer token, 401 with no credential, and 404 for an unknown `analysisId`. Add a test for `GET /api/v1/analyses/a1/files` where analysis `a1` exists. The test must assert 404 `not_found` with the message of `app.notFound`, `No route for GET …`, and not the message of the guard. Make sure that the file passes.

## 4. The absolute path of an artifact

- [x] 4.1 Add `absolutePath: string | null` to `ArtifactEntry` in `src/api/artifacts.ts`, with a JSDoc block. Change the JSDoc of `path` so that it names the `path` query value and not `GET {A}/files`.
- [x] 4.2 Give each entry of `GET {A}/artifacts` its `absolutePath` as design D6 tells: one `workspaceReadRoot` call for each request, `null` for `workspace_unavailable`, and 500 `internal_error` for a `DbError`. Update the JSDoc of `artifactRoutes`.
- [x] 4.3 Make sure that `src/server/routes/artifacts.test.ts` covers the scenarios "An absolute path for each item" and "A workspace folder that the server cannot locate". A test must show that the joined path is under the canonical workspace root. Give `absolutePath` in each existing expectation, and make sure that the file passes.

## 5. Verification

- [x] 5.1 Run `bun run format:file` on each changed file in `src/`. Then run `bun run typecheck`, `bun run lint`, and `bun run test` on each changed test file. Make sure that each command passes.
- [x] 5.2 Run `bun run test` one time for the full cli suite. Make sure that it passes.
