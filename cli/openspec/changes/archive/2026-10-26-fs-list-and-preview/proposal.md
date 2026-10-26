# Proposal

## Why

The file picker of Flamme (inflexa-ai/himmel#111) shows one page of a folder. Each entry has a kind badge, an item count, an "Already an input" mark, and the step that wrote the file. The picker also draws a thumbnail for each entry and opens Quick Look on Space. Two GitHub issues name the gaps:

- #715: `GET /api/v1/fs/list` (`src/server/routes/fs.ts:101-129`) gives the facts of the disk only. One page of the picker must come from one call. Thus the list must also give the kind, the item count, the input mark, and the origin step of each entry. The path field of the picker also needs a completion by a name prefix. This issue holds the work of the closed #714 (the batched artifact lookup) and #716 (the path completion).
- #717: no route gives a preview of a file or a folder.

## What Changes

- **BREAKING**: the entry field `kind` of `GET /api/v1/fs/list` gets the kind of the file from the kind map of the `fs` routes, or `null`. The type of the entry from the folder read (`file`, `folder`, or `symlink`) moves to the new field `type`. No alias stays.
- Each entry of `GET /api/v1/fs/list` gets `itemCount`, `isInput`, and `origin`:
  - `itemCount`: the count of the names in a folder, or `null`.
  - `isInput`: true when the entry is a declared input of the analysis of `analysisId`, or is inside an input folder.
  - `origin`: `{runId, stepId}` of the step that wrote the file, from the artifact ledger of the analysis of `analysisId`, or `null`.
- `GET /api/v1/fs/list` takes the optional query value `namePrefix`. It gives only the entries whose name starts with the prefix, with no regard to case. A hidden entry comes back only when the prefix starts with a dot.
- The list reads the facts of each entry of the page in a queue of fixed width. It reads the origin of each entry of the page in one ledger read. The harness gets this read in the harness change of the same name.
- The list reads the ledger only when the runtime boot is ready. Before that, `origin` is `null`, and the list still answers.
- A new route `GET /api/v1/fs/preview?path=<absolute path>` gives one member of a preview union: `table`, `text`, `figure`, `folder`, or `card`. It reads a fixed maximum count of bytes from a file. It does no `stat` for each entry of a folder.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the folder list gives the kind, the item count, the input mark, and the origin of each entry, and it takes a name prefix. The file system group gets the preview route. The file system routes read the artifact ledger for the origin only, and they still answer before the runtime boot is ready.

## Impact

- cli code: `src/server/routes/fs.ts`, `src/server/routes/files.ts`, `src/server/routes/artifacts.ts`, `src/server/app.ts`, `src/api/fs.ts`, `src/lib/folder_listing.ts`, `src/modules/analysis/boundary.ts`, and the tests of these files.
- The harness gets one new ledger read and its exports in the harness change `fs-list-and-preview`. The cli calls it from `@inflexa-ai/harness`. The harness must be on npm and the cli pin must name that version before a cli release.
- No cli client and no TUI code calls a route under `/api/v1/fs`. The TUI file picker reads `src/lib/folder_listing.ts` directly, and this change only adds to that file. Thus no fetcher and no TUI code changes.
- The callers of Flamme move in inflexa-ai/himmel#143, in a different repository.
