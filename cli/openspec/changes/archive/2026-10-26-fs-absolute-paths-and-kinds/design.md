# Design

## Context

- `fsRoutes` (`src/server/routes/fs.ts:56-104`) gives `/home` and `/list`. `/home` gives `homedir()` as it is (`:61-64`). `/list` refuses a path that is not absolute, and it removes each `..` segment as text with `resolve` before the folder read (`:66-101`). `FsRouteOpts` holds `entryDetails` only (`:11-17`).
- `fileRoutes` (`src/server/routes/files.ts:60-84`) is the route `GET {A}/files`. `locateTarget` selects the roots from the form of the path (`:125-138`). `app.ts:76` mounts it behind `analysisGuard`.
- `serveFile` (`src/server/routes/files.ts:93-119`) does the real-path test against a list of `ReadRoot`. Then it opens the real path with `O_NOFOLLOW` (`:26`). It also gives the stat, the tag, the range, the sandbox header (`:29`, `:200`), and the stream. `report_pages.ts:177` calls it with the folder of the report session as the one root.
- `classifyRealPath` (`src/modules/analysis/boundary.ts:100-109`) gives `outside` for an empty list of roots, with no disk read. `report_pages.ts` depends on this rule through `serveFile`.
- `analysisGuard` (`src/server/analysis_guard.ts:30-47`) reads the id from the URL path only (`:32`). It gives 404, then it takes the instance lock through `AnalysisGuardOpts.acquireLock`, and it gives 409 `locked`. `app.ts:70` mounts it for `/api/v1/analyses/:analysisId/*`. `app.test.ts:92-135` covers it through the file route.
- The list route of the artifacts (`src/server/routes/artifacts.ts:81-109`) copies each ledger row as it is (`:106`). The ledger path is relative to the workspace folder.
- `workspaceReadRoot` (`src/modules/analysis/boundary.ts:116-120`) gives the workspace root as text and in canonical form. It makes no folder and records no anchor sighting. Its error is `workspace_unavailable` or a `DbError`.
- `filterValue` (`src/server/http.ts:80-82`) treats an absent or empty query value as absent.
- No cli client and no TUI code calls `GET {A}/files` or `GET {A}/artifacts`. Only the tests do: `files.test.ts`, `app.test.ts:92-135`, and `artifacts.test.ts:213-332`.

## Goals / Non-Goals

**Goals:**

- One implementation opens and streams each served file. `fs/read` and the page of a report session share `serveFile`.
- The `analysisId` guard of the `fs` routes is one middleware of `fsRoutes`. Each later route of that router gets it with no extra code.
- `FileKind` and the map are importable by a later route.
- The absolute path rule is one function of `fs.ts`. `/list`, `/read`, and each later route of the router call it.

**Non-Goals:**

- No route gives the kind of a file. A later issue adds `kind` to the entries of the `fs` routes.
- No `isInput` or `origin` on an entry. `analysisId` does not change a response of this change.
- No change to the content type of a file. A different issue changes it for `fs/read`.
- No cli fetcher for `fs/read`. No cli surface reads the bytes of a file, and the TUI opens a file with the desktop opener.
- No change to the page route of a report session, to `hostOriginGuard`, or to `credentialAuth`.

## Decisions

### D1. `fs/read` calls `serveFile` with no root limit

`classifyRealPath` and `serveFile` take the value `"unlimited"` in place of a list of roots. With this value, the real path of each existing path is `in`, and each absent path is `absent` and inside as text. Thus an absent path gives 404. Each other failure of the resolve gives 403 with the code of the operating system, through `unreadable`. An empty list of roots keeps its meaning, `outside`, thus the page route of a report session does not change.

The read route reads `path` with the function of D8, as `/list` does. Then it calls `serveFile` with `"unlimited"`. The open still uses `O_NOFOLLOW` on the real path, thus a link that replaces the last part after the resolve gives 403.

Alternative: give `serveFile` the root of the file system of the requested path as its one root. On Windows, a junction from one drive to a different drive resolves outside that root, and the route then refuses it. Rejected.

Alternative: let `classifyRealPath` take `null` or an empty list for "no root". The page route depends on "no root means outside". Rejected.

Alternative: split `serveFile` into a resolve part and a serve part, and give the read route its own resolve. This makes a second real-path function with its own set of absent codes. Rejected.

### D2. The `analysisId` guard is a middleware of `fsRoutes`

`src/server/analysis_guard.ts` gets `analysisQueryGuard(opts)`. It reads `filterValue(c.req.query("analysisId"))`. With no value, it calls `next()`. With a value, it does the same steps as `analysisGuard`. The two middlewares share one private function, thus the 404 text, the lock call, and the 409 body stay identical.

`fsRoutes` registers it first, with `routes.use("*", …)`. Thus each route of the router, now and later, gets it before its own handler.

Alternative: mount the guard in `app.ts` at `/api/v1/fs/*`. A route test of `fsRoutes` then cannot see the guard. Rejected.

### D3. `FsRouteOpts` holds the disk reads and the lock

`FsRouteOpts` becomes `FileRouteOpts & AnalysisGuardOpts & { entryDetails; homedir }`. `homedir` is a `() => string`, with `homedir` of `node:os` as the default. `DEFAULT_FS_ROUTE_OPTS` combines `DEFAULT_FILE_ROUTE_OPTS`, `DEFAULT_ANALYSIS_GUARD_OPTS`, `entryDetails`, and `homedir`. A test replaces `open`, `chunkBytes`, `acquireLock`, or `homedir`. A replaced `homedir` lets a test give a home path behind a link, with no change to the `HOME` variable of the shared test process.

### D4. The route `GET {A}/files` goes away

`fileRoutes`, its mount at `app.ts:76`, and `locateTarget` go away. `locateTarget` is the one caller of `inputReadRoots` (`src/modules/analysis/boundary.ts:127-133`). Thus `inputReadRoots` and its tests in `boundary.test.ts` go away too. `workspaceReadRoot` stays, because `report_pages.ts`, `machine.ts`, `artifact_open.ts`, and the artifact list use it.

`files.ts` keeps `serveFile`, `FileRouteOpts`, `DEFAULT_FILE_ROUTE_OPTS`, `FileResponseOpts`, `unreadable`, and the private helpers. The response options of the read route and its `notAFile` move to `fs.ts`, their one caller. The JSDoc of `serveFile` names the read route and the page route as its callers.

The text of `FORBIDDEN_MESSAGE` names "the files of the analysis". After this change, no caller reads the files of an analysis. The text becomes neutral, for example "The path is outside the folders that the server serves."

### D5. `/home` gives the canonical home folder

`/home` gives `canonicalPathAsync(opts.homedir())`. The helper falls back to `resolve` when `realpath` fails, thus the route never fails. The spec names this fallback. A home folder that the server cannot resolve is a broken machine, and a 500 response helps no client. One `realpath` runs for each request.

### D6. Each artifact entry gets `absolutePath`

The list route calls `workspaceReadRoot(analysisId)` one time for each request, in parallel with the ledger read. Each entry gets `join(root.canonical, entry.path)`. A `workspace_unavailable` error gives `null` for each entry, because a moved or deleted anchor is a normal state of the database and the folders. A `DbError` gives 500 `internal_error`.

The name `absolutePath` and its `null` rule copy `InputView.absolutePath` (`src/api/analyses.ts:231`). `ArtifactEntry.path` keeps its relative form, because the `path` query value of the ledger takes that form.

Alternative: a `realpath` for each entry. This costs one disk call for each row, and a file that a run removed gives no path at all. Rejected.

Alternative: `workspaceRootForAnalysisId`. It requires a writable workspace, and a read must not. Rejected.

### D7. `FileKind` and the kind map

`src/api/fs.ts` gets `export type FileKind = "table" | "figure" | "code" | "log" | "data" | "doc"`. The values are lower case, as `FolderEntryKind` and `ArtifactRole` are. The label of a badge is the work of the client.

`src/modules/fs/file_kind.ts` exports `fileKindOf(name: string): FileKind | null`. It reads the last part of the name after the last separator, thus a caller can give a name or a path. It builds one `ReadonlyMap<string, FileKind>` from the table of the spec at the load of the module.

The extension rule is the rule of the artifact ledger: no dot, a dot at the first character, or a dot at the end gives no extension. The match puts the extension in lower case. For `gz`, the function looks up the extension of the name before `.gz`, and it falls back to `data`.

The module carries one comment: the harness ledger classifies a file by its folder (`harness/src/schemas/artifact-manifest.ts:33-46`), and this map uses the extension only. The two can disagree for one file, and neither must change to match the other.

### D8. One function reads the absolute path of a request

`fs.ts` holds one function that reads the `path` query value. It refuses an absent value, a value that is not absolute, and a value with a NUL byte. The refusal is 400 `validation_error`, with the field error under `path`. Otherwise it gives the path after `resolve`, thus each `.` and `..` segment goes as text. It gives a `Result`, and its error is the response to send. `/list` and `/read` call it, and a later route of the router calls it too.

The function stays private in `fs.ts`, because each `fs` route is in that file.

## Risks / Trade-offs

- [The read route gives each file that the server user can read] → The decision of the issue. The credential check, the Host and Origin check, and the `Sec-Fetch-Site` rule of the cookie stay. A report page has an opaque origin, and the guard lets `Origin: null` through only under `/report-sessions/`. The sandbox header stays on HTML, XHTML, SVG, and XML.
- [A read with `analysisId` takes the instance lock] → Each `{A}` route takes it at the first request too. The lock fences an old binary. The lock file is the one write of the `fs` routes, and a read changes no file of the analysis.
- [The Flamme callers of `GET {A}/files` break] → Flamme moves to `fs/read` in a different repository. No alias, by the decision of the issue.
- [`"unlimited"` widens a shared function] → The empty list keeps its meaning. A unit test of `classifyRealPath` covers the new value, and the route tests read a file outside each analysis and a file through a link.

## Migration Plan

No data changes. A client of `GET {A}/files` sends `GET /api/v1/fs/read?path=<absolute path>` and, for a file of an analysis, `analysisId`. A workspace file gets its absolute path from `absolutePath` of the artifact list, or from the workspace folder joined with the relative path.
