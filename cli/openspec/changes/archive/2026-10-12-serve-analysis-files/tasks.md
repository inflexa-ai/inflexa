# Tasks

## 1. The shared roots and the real-path test

- [x] 1.1 Add `range_not_satisfiable` with status 416 to `ApiErrorCode` and `API_ERROR_STATUS` in `src/api/common.ts` (D8). Make sure that `bun run typecheck` adds no error.
- [x] 1.2 Move `inputAbsolutePaths` from `src/server/routes/analyses.ts` into `src/modules/analysis/input.ts` with its bound on the paths in flight (D1). Update the inputs route to import it. Make sure that `src/server/routes/analyses.test.ts` and `src/modules/analysis/input.test.ts` pass.
- [x] 1.3 Add the real-path test to `src/modules/analysis/boundary.ts` (D2). It does one `realpath` of the target, then the existing `contains` against the canonical form of each root. It gives `in` with the real path, `outside`, or `absent`, and each other failure goes to the error channel. An `absent` verdict also tells if the path is inside the text form of a root (D3). Add cases to `src/modules/analysis/boundary.test.ts`, and make sure that they pass:
  - a file inside a root, and a path equal to a root that is one file
  - a symbolic link that leaves the roots
  - a sibling prefix
  - an absent path, a broken link, and a loop of links
  - an absent path inside the text form of a root, and an absent path outside it
- [x] 1.4 Add the two root lookups of a read to `src/modules/analysis/boundary.ts` (D1). The lookup for a relative path gives the workspace root from `workspaceRootForAnalysisId` in its text form and its canonical form, or the message of a `workspace_unavailable`. The lookup for an absolute path gives the canonical inputs from `inputAbsolutePaths`. Neither lookup makes a folder or records a sighting. Add cases to `boundary.test.ts`, and make sure that they pass:
  - the input roots of an analysis with an anchored input and an absolute input
  - an unlocatable workspace that gives the message
  - no change to the sighting time of an anchor after each lookup

## 2. The file route

- [x] 2.1 Add `src/server/routes/files.ts` with `fileRoutes()` and its `GET /` handler (D3, D4, D8, D9). The handler does the query checks, `holdConnection`, the roots of the form of the path, and the real-path test. Then it opens the real path with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, and it reads the `stat` of the open handle. Add route tests in `src/server/routes/files.test.ts`, and make sure that they pass:
  - a relative path of a workspace file, and a relative path with `..` that stays inside the workspace
  - an absolute path inside a declared input folder, and the absolute path of a declared input that is one file
  - an absolute path of a workspace file that no input holds, which gives 403
  - a relative path whose `..` leaves the workspace, which gives 403
  - each error of the requirement "The file route refuses a bad request with a named error"
  - an absent path inside the workspace, which gives 404, and an absent absolute path outside each input, which gives 403
  - a symbolic link that leaves the roots, and a path outside each root
  - a folder, and a FIFO that gives 400 at once
- [x] 2.2 Add the headers, the tag, the conditional order, the single range, the 416, the download name, and the sandbox for the document types (D6, D7). Add route tests, and make sure that they pass:
  - the content type and `nosniff`, and an unknown extension
  - `Range: bytes=0-99` of a 1000-byte file, a suffix range, and a `<last>` past the end
  - `bytes=1000-`, which gives 416 with `Content-Range: bytes */1000`
  - more than one range, and an `If-Range` with an old tag, which each give 200
  - `If-None-Match`, which gives 304, and a changed file, which gives a new tag
  - `download=1` with a name that is not ASCII
  - HTML and SVG with `Content-Security-Policy: sandbox`
- [x] 2.3 Stream the body from the open handle (D5). Close the handle one time on the end, on `cancel`, and on an error. Close it at once for a 304, a 416, and a `HEAD` request. A read error after the status ends the body with an error and writes one log line. Add tests, and make sure that they pass:
  - a file larger than the read buffer streams the correct bytes
  - a `HEAD` request gives the headers and no body
  - a canceled body closes the handle
  - a handle whose read fails ends the stream with an error and closes the handle
- [x] 2.4 Mount `fileRoutes()` at `/api/v1/analyses/:analysisId/files` in `src/server/app.ts`, after `analysisGuard` (D9). Add tests through `buildApp` in `src/server/app.test.ts`, and make sure that they pass:
  - a browser gets a figure with the session cookie of `signIn`
  - a request with no credential gets 401
  - an unknown analysis gets 404

## 3. The same test in `artifacts/resolve`

- [x] 3.1 Give the verdict for a `workspace-file` path in `src/modules/harness/artifact_open.ts` (D10). The verdict is the form test, then the real-path test against the canonical workspace root. Map the verdict in `src/server/routes/artifacts.ts`. Add cases to `src/server/routes/artifacts.test.ts`, and make sure that they pass:
  - a symbolic link that leaves the workspace resolves nowhere, with `degraded` true and, with `materialize`, the error `unavailable`
  - a folder inside the workspace resolves
  - an absent file stays `missing`

## 4. Verification

- [x] 4.1 Run `bun run format:file` on each changed file in `src/`. Then run `bun run lint` and `bun run typecheck`. The typecheck has 5 known errors in `src/modules/refs/`, because the linked harness `dist/` is stale. Make sure that no other error is new.
- [x] 4.2 Run the full suite one time with `bun run test`. Make sure that no test fails, except the known local failure `src/modules/libs/composition.test.ts` (python3 lacks `packaging`). The local run also has the failures of the stale linked harness `dist/`, which has no `referenceReceiptContentDigest`. They are in `src/modules/refs/`, the setup and policy tests, and the `refs` cases of `src/cli/cli.test.ts`, and they are outside this change.
