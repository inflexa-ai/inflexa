# Design

## Context

- `buildApp` mounts each `{A}` route after `analysisGuard` (`src/server/app.ts:61-70`). The guard gives 404 for an unknown analysis and 409 for a lock that a different process holds. `credentialAuth` accepts the bearer token or the session cookie on each `/api/*` path (`app.ts:126-161`). The cookie has `Path=/api`, thus a route under `{A}` gets it with no change.
- `computeRoots` (`src/modules/analysis/boundary.ts:24-39`) makes the workspace folder (`ensureOutputDir`), and it resolves each input with `resolveInputPath`. That call records an anchor sighting by default (`src/modules/anchor/anchor.ts:151,160`). `computeRoots`, `canRead`, and `canWrite` have no production caller. `contains` (`boundary.ts:54-59`) is a lexical, boundary-safe test.
- `workspaceRootForAnalysisId` (`src/modules/analysis/output.ts:180-197`) is memoized for 5 s and shares a lookup in flight. It makes no folder, and it records no sighting. It needs a writable anchor folder, as `resolveOutputDir` does.
- `inputAbsolutePaths` (`src/server/routes/analyses.ts:494-514`) gives the canonical path of each input, with one anchor resolution for each anchor and no sighting. It is private to the route file.
- `canonicalPathAsync` (`src/lib/paths.ts:30-32`) is `realpath`, and it falls back to `resolve` on each error. `errnoCode` (`src/lib/fs.ts:195`) reads the code of a thrown error.
- The harness `classifyWithinRoot` (`harness/src/lib/fs-helpers.ts:103`) does a real-path test against one root. The harness read tools open a file with `O_NOFOLLOW` after that test (`harness/src/workspace/filesystem.ts:336-361`).
- Hono answers a `HEAD` request with `new Response(null, <the GET response>)` (`node_modules/hono/dist/hono-base.js:279-280`). It drops the body of the GET response, and it does not cancel the stream.
- Staging puts an input in the workspace with a hard link or a copy (`src/modules/staging/staging.ts:76-79`). Thus a staged input is inside the workspace by real path.
- `hono/utils/mime` gives `getMimeType(filename)`. It maps `html`, `htm`, `xhtml`, `svg`, and `xml` to the document types, and adds `charset=utf-8` to a text type.

## Goals / Non-Goals

**Goals:**

- One real-path test that the file route and `artifacts/resolve` share.
- A file route that reads no whole file, makes no folder, records no sighting, and runs each disk operation off the event loop. The anchor lookup can repair the stored path of a moved anchor (`src/modules/anchor/anchor.ts:113-116`), as each workspace lookup does.

**Non-Goals:**

- A change to `computeRoots`, `canRead`, or `canWrite`. They stay the write-boundary contract.
- A client fetcher, or a TUI change. A browser uses the URL.
- The pages of a report (#641). An HTML file of the workspace runs no script under the sandbox.
- The `presentations/` folder of `artifacts/resolve`. Its write and its path stay as they are.

## Decisions

### D1. The roots come from the memoized workspace root and the canonical inputs, not from `computeRoots`

The form of the path selects its roots, and the route computes only the roots of that form. `boundary.ts` gets the two lookups:

- for a relative path: the workspace root from `workspaceRootForAnalysisId`, and its canonical form from `canonicalPathAsync`. A `workspace_unavailable` gives no root and the message of that error.
- for an absolute path: the canonical path of each declared input that resolves, from `inputAbsolutePaths`

`inputAbsolutePaths` moves from `src/server/routes/analyses.ts` into `src/modules/analysis/input.ts`, with its bound on the paths in flight. The inputs route and the new lookup both call it. A module cannot import a route, thus the move is necessary to share it.

A `DbError` from the workspace lookup or from the input list gives 500. `inputAbsolutePaths` changes a failed anchor resolution into `null`, as the inputs view needs. Thus that input is not a root, and an absolute path inside it gets 403. This is the deny-first side, and the shared helper keeps its behavior. A relative path, the common form of a figure, thus costs one memoized lookup and one `realpath` of the root. It reads no input.

Alternative: `computeRoots`. It makes the workspace folder on each request, and it writes one anchor sighting for each input on each request. A page with many figures would then write the database for each figure. Its readable list is also lexical. Rejected.

### D2. The real-path test: one `realpath` of the target, `contains` against canonical roots

`boundary.ts` gets the real-path test. It takes a list of canonical roots and an absolute path, and it gives one of these verdicts:

- `in`, with the real path
- `outside`
- `absent`: `realpath` failed with `ENOENT`, `ENOTDIR`, or `ELOOP`

Each other `realpath` failure goes to the error channel with its cause. The test calls `realpath` from `node:fs/promises` one time, then the existing `contains` for each root.

The caller gives each root in two forms: the text form that the lookup gave, and the canonical form. The real path uses the canonical form. The `absent` verdict also tells if the path is inside a root as text, against the text form (D3). For an input, the two forms are the same.

Alternative: `classifyWithinRoot` for each root. It takes one root, thus it does a `realpath` of the target again for each root, and a `realpath` of each root again. It also throws on `EACCES`. Rejected for the list of roots. The verdicts and the error codes are the same as those of `classifyWithinRoot`.

### D3. The path rule

The rule is the rule of the issue and of the user:

- A relative path joins the workspace root, and its real path must be inside the canonical workspace root. With no workspace root, the route gives 409 `conflict` with the message of the workspace error, as `POST {A}/output-dir` does.
- An absolute path must have its real path inside the canonical path of a declared input. A real path equal to an input passes, thus an input that is one file works.

An absolute path inside the workspace gets 403, unless a declared input holds it. A client uses the relative form of a workspace file.

A relative path with `..` is permitted when its real path stays inside the workspace. The real-path test is the guard, not the form of the path.

A path that does not exist gets 404 only when the path is inside a root of its form as text. Each other absent path gets 403, because the issue gives 403 to each path outside the roots. The text test is `contains` on the path with each `.` and `..` resolved, and no link resolved:

- a relative path: the joined path against the workspace root, as `workspaceRootForAnalysisId` gives it
- an absolute path: `resolve` of the path against each canonical input

A client that sends an absolute path that is not canonical, for example through a linked home folder, gets 403 for an absent file. That is the deny-first side.

### D4. The route opens the real path, and the open file gives the facts

The route opens the real path that passed the test with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`. Each flag is `?? 0` on a platform that does not have it.

- `O_NOFOLLOW`: a symbolic link that replaces the last part after the test fails with `ELOOP`, and the route gives 403.
- `O_NONBLOCK`: a FIFO opens at once, and it does not wait for a writer. Without it, a FIFO that an agent makes holds a thread of the file system pool for ever. The flag does not change a read of a regular file.

Then `stat` of the open handle gives the kind, the size, the inode, and the time of the last change. A folder or a different entry that is not a regular file closes the handle and gives 400. The tag, the length, and the bytes then describe one file.

### D5. The body streams from the open handle

The body is a pull `ReadableStream` that reads the handle with `FileHandle.read` into a fixed buffer. It reads from the first byte to the last byte of the range. The end of the range, `cancel`, and a read error each close the handle, and the handle closes one time. A client that disconnects cancels the stream.

The status and the headers go out before the first read of the body. Thus a read error after that point cannot change the status. The stream then calls `controller.error`, the handle closes, and the server writes one log line with the cause. The client gets fewer bytes than `Content-Length`, thus it sees a cut body. Each error of D8 comes before the response.

The route closes the handle and gives no body for a 304, a 416, and a `HEAD` request. Hono drops the body of a `HEAD` response with no cancel, thus a stream would hold the descriptor.

The route calls `holdConnection`, because the `realpath` and the open on a hung mount can take more than 10 s before the response.

Alternative: `Bun.file(path).slice()`. It opens the file by name again, after the test, thus it loses the `O_NOFOLLOW` guard. `Bun.file(fd)` does not close a descriptor that it did not open. Rejected.

Alternative: `fh.createReadStream({ start, end })` with `Readable.toWeb`. It is permitted if the handle closes on `cancel`. The pull stream is the default, because its close is in one place.

### D6. The headers

- `Content-Type`: `getMimeType` from `hono/utils/mime` of the last part of the requested path, else `application/octet-stream`. The requested name, not the name of the real path, gives the type and the download name. A link inside a root can have a different name than its target. The client asked for the requested name. The sandbox obeys the type that the route sends, thus each choice is safe.
- `Content-Security-Policy: sandbox` when the type before `;` is `text/html`, `application/xhtml+xml`, `image/svg+xml`, `application/xml`, or `text/xml`. A sandboxed document has an opaque origin. Thus a script in it cannot send the `SameSite=Strict` cookie, and `Sec-Fetch-Site` of its requests is not `same-origin`.
- `Content-Disposition` for `download=1`: `attachment; filename="<ASCII form>"; filename*=UTF-8''<percent-encoded name>`. The ASCII form changes each character that is not printable ASCII, and each `"` and `\`, to `_`.
- `ETag`: a strong tag, `"<ino>-<size>-<mtimeNs>"`, each field an integer in hex, from `stat({ bigint: true })` of the open handle. The nanosecond time keeps the window of a rewrite with the same size at the time resolution of the file system.
- `Cache-Control: no-cache`, `X-Content-Type-Options: nosniff`, `Accept-Ranges: bytes`, and `Content-Length`.

Alternative: `Content-Disposition: attachment` for each HTML and SVG file. An `<img>` of an SVG figure then works, but a frame that shows an HTML file of the workspace does not. The issue permits either. The sandbox keeps the file viewable. Not chosen.

Alternative: `Content-Security-Policy: sandbox` on each response. Chrome then refuses to show a PDF file, because the sandbox stops its viewer. Rejected.

### D7. The conditional and range order

1. `If-None-Match`: a list of tags, each with an optional `W/` prefix, or `*`. A match with the current tag gives 304 with the `ETag`, `Cache-Control`, and no body.
2. `If-Range`: when it is present and it is not the current tag, the route ignores `Range`. A date in `If-Range` also makes the route ignore `Range`.
3. `Range`: the unit `bytes`, case-insensitive, with one range. `bytes=<first>-<last>`, `bytes=<first>-`, and `bytes=-<suffix>`. A `<last>` below `<first>` is a bad form. A `<last>` at or past the end means the end.
4. A range is unsatisfiable when `<first>` is at or after the size, or when a suffix is 0, or when the file is empty. It gives 416 `range_not_satisfiable` with `Content-Range: bytes */<size>` and the error body.
5. Each other `Range` value is ignored, and the route gives 200 with the full file.

### D8. The errors

| Condition | Response |
|-|-|
| `path` absent, empty, or with NUL | 400 `validation_error` |
| `download` present and not `1` | 400 `validation_error` |
| relative path, no workspace root | 409 `conflict` |
| real path outside each root of the form | 403 `forbidden` |
| `realpath` gives `absent`, path inside a root of the form as text (D3) | 404 `not_found` |
| `realpath` gives `absent`, path outside each root of the form as text | 403 `forbidden` |
| open fails with `ELOOP` | 403 `forbidden` |
| open fails with `ENOENT` or `ENOTDIR` | 404 `not_found` |
| folder, FIFO, socket, or device; the open of a socket fails with `EOPNOTSUPP` or `ENXIO` | 400 `validation_error` |
| `realpath` of a socket fails with `EOPNOTSUPP` (Bun on macOS) | 403 `forbidden`, with `details.code`, by the row "each other failure" below |
| each other `realpath`, open, or `stat` failure | 403 `forbidden`, with `details.code` |
| `DbError` | 500 `internal_error` |

A socket keeps the deny-first order. A fallback to the real path of the parent folder could give 400 for a socket before the test of the roots. Then a socket outside the roots would get 400, not 403. Thus the route gives 403 when the real path of a socket fails.

`src/api/common.ts` gets `range_not_satisfiable: 416` in `ApiErrorCode` and `API_ERROR_STATUS`. Each row of the table comes before the response. A read error after the response obeys D5.

### D9. The route file

`src/server/routes/files.ts` gives `fileRoutes()`, with one `GET /` handler. `buildApp` mounts it at `/api/v1/analyses/:analysisId/files`, after `analysisGuard`. The route needs no harness runtime, thus no `requireRuntime`.

### D10. `artifacts/resolve` uses the same test for a `workspace-file`

`artifact_open.ts` gets the verdict for a `workspace-file` path: the form test of `validatePath`, then the real-path test of D2 against the canonical workspace root. The route maps each verdict:

- a bad form, `outside`, or a failure of the test: the response of a bad form today. That is `path: null`, `degraded: true`, and with `materialize` the error `unavailable` with the reason that the path is not inside the analysis.
- `in`: the flow of today. The response keeps the joined path, not the real path.
- `absent` inside the workspace as text: the flow of today. The entry is degraded, and `materialize` gives `missing`.
- `absent` outside the workspace as text: the same as `outside`. On POSIX `validatePath` refuses each such path first. A Windows `..\` path can pass `validatePath`.
- no workspace root: the flow of today, which gives `unresolved`.

A folder inside the workspace gets `in`, thus the reveal of a folder still works.

## Risks / Trade-offs

- [A folder in the middle of the path changes to a symbolic link between the test and the open] → `O_NOFOLLOW` guards only the last part. Node has no `openat2` with `RESOLVE_BENEATH`. The harness read tools accept the same limit. The test refuses each link that exists before the request, thus a race needs an agent that changes a folder during the request.
- [A hung mount holds a thread of the file system pool] → The same limit as each route of PR #653. The request stops, and the event loop stays free.
- [The tag comes from the metadata] → A rewrite with the same size inside the time resolution of the file system keeps the tag. The nanosecond time makes that window small, and a run writes a file much less frequently than that.
- [A relative path to an input] → An input folder that the user declared is outside the workspace, thus only its absolute path reaches it. A staged copy of the input is inside the workspace, and its relative path works.
- [A read-only anchor folder] → `workspaceRootForAnalysisId` needs a writable folder, thus a relative path gets 409. `artifacts/resolve` has the same limit today.
- [An HTML chart of the workspace shows no chart] → The sandbox stops its script. #641 serves the report pages.
