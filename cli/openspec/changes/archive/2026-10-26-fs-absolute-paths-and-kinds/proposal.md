# Proposal

## Why

The file picker of Flamme (inflexa-ai/himmel#111) keeps each pick as an absolute path. But the routes that read the disk take different forms of a path, and they live under different prefixes. Two GitHub issues name the gaps:

- #742: `GET /api/v1/fs/list` takes an absolute path (`src/server/routes/fs.ts:66`). `GET {A}/files` takes a path relative to the workspace, or an absolute path inside a declared input. It refuses an absolute path inside the workspace (`src/server/routes/files.ts:125-138`). `GET {A}/artifacts` gives a path relative to the workspace (`src/api/artifacts.ts:50`). Thus a client must change the form of a path between two routes.
- #713: the picker shows a kind badge for each file: Table, Figure, Code, Log, Data, or Doc. No code of the cli maps an extension to such a kind. The picker UI must not keep its own map, thus the server holds the only map.

The later `fs` issues of the picker work add routes under `/api/v1/fs`. Each of them uses the `analysisId` guard, the absolute path rule, and the kind map of this change.

## What Changes

- Each route that reads a path or the bytes of a file is under `/api/v1/fs`. Each route there takes and gives absolute canonical paths. The client expands `~`.
- **BREAKING**: `GET {A}/files` goes away, with no alias. `GET /api/v1/fs/read?path=<absolute path>` takes its place. `fs/read` reads a file at each path of the machine. It has no root limit. It keeps the `Range`, `ETag`, `O_NOFOLLOW`, and `Content-Security-Policy: sandbox` behavior of the old route.
- Each route under `/api/v1/fs` takes the optional query value `analysisId`. With a value, the route gives the same 404 and takes the same instance lock as the guard of the `{A}` routes.
- `GET /api/v1/fs/home` gives the canonical path of the home folder.
- Each entry of `GET {A}/artifacts` gets `absolutePath`: the canonical workspace root joined with the relative `path`. It is `null` when the workspace folder cannot be located.
- A new module `src/modules/fs/file_kind.ts` maps the extension of a file name to a `FileKind`, or to `null`. The wire type `FileKind` is in `src/api/fs.ts`. No route gives the kind yet. A later issue adds it to the entries of the `fs` routes. This reverses the non-goal "no kind of file on the server" of the archived change `filter-the-run-and-artifact-reads`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the route groups put each folder list, file read, and file search under `/api/v1/fs`. The `fs` routes guard an optional `analysisId`, give canonical paths, and read each path with no root limit. The bytes route and its errors move to `fs/read`. The artifact list gives an absolute path for each entry. The `fs` routes get one kind map for a file. The page route of a report session names the read route as the source of its file behavior.

## Impact

- cli code: `src/server/app.ts`, `src/server/analysis_guard.ts`, `src/server/routes/fs.ts`, `src/server/routes/files.ts`, `src/server/routes/artifacts.ts`, `src/modules/analysis/boundary.ts`, `src/api/fs.ts`, `src/api/artifacts.ts`, the new `src/modules/fs/file_kind.ts`, and the tests of these files.
- `src/server/routes/report_pages.ts` keeps its call of `serveFile`, with no change.
- No cli client and no TUI code calls `GET {A}/files` or the artifact list. Thus no fetcher changes.
- The callers of Flamme move in inflexa-ai/himmel#144, in a different repository.
- The harness does not change. Its folder classifier (`harness/src/schemas/artifact-manifest.ts:33-46`) stays as it is.
