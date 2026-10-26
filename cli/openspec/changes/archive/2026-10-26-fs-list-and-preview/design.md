# Design

## Context

- `fsRoutes(opts)` (`src/server/routes/fs.ts:89-144`) gives `/home`, `/list`, and `/read`. `app.ts:60` mounts it as `fsRoutes()`, with no boot. `analysisQueryGuard` is its first middleware (`:94`). `absolutePathOf` (`:53-66`) reads each `path`.
- `/list` reads all names with `readFolder` (`src/lib/folder_listing.ts:97-111`), slices the page, and reads `entryDetails` for each entry of the page with `Promise.all` (`fs.ts:119-125`). The `perPage` cap of 200 bounds the count of `stat` calls in flight.
- `FolderEntryView.kind` (`src/api/fs.ts:29`) is the type of the entry from the folder read: `file`, `folder`, or `symlink`. `FileKind` (`src/api/fs.ts:61`) and `fileKindOf` (`src/modules/fs/file_kind.ts:29-38`) exist, and no route gives them yet.
- `serveFile` (`src/server/routes/files.ts:59-85`) does `classifyRealPath`, then opens the real path with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (`:26`, `:82`), and maps an open failure in `openFailure` (`:93-108`). Then `serveHandle` streams the file.
- The SQLite table `analysis_inputs` holds an absolute canonical path, or a path relative to an anchor. `inputAbsolutePaths` (`src/modules/analysis/input.ts:108-131`) gives the canonical absolute path of each input, with one anchor resolution for each anchor and no sighting write. `contains` (`src/modules/analysis/boundary.ts:57-63`) is the boundary-safe test, and it is private.
- `locateRoot` (`src/server/routes/artifacts.ts:65-69`) gives the canonical workspace root of an analysis, `null` for `workspace_unavailable`, and a `DbError` otherwise.
- The artifact ledger stores a path relative to the workspace root. The harness change `fs-list-and-preview` adds `queryArtifactOrigins(pool, analysisId, paths)`: one statement with `path = ANY($2::text[])` over the key `(analysis_id, path)`. It gives `{path, runId, stepId}` for each path that has a row, and it sends no statement for an empty list.
- The analysis list degrades a field that the runtime gives: with no runtime, or with a failed read, the field is absent or `null`, and the list still answers (`src/server/routes/analyses.ts:251-254`, `:337-345`).
- No cli client and no TUI code calls a route under `/api/v1/fs`. The TUI file picker imports `readFolder` and `entryDetails` directly (`src/tui/components/dialog/file_picker.tsx:10`).

## Goals / Non-Goals

**Goals:**

- One call gives one full page of the picker list.
- The page bounds the cost of a list request. The one exception is the read of the names that the sort needs.
- One open step serves `fs/read` and `fs/preview`.

**Non-Goals:**

- No `facts` member of the preview for an h5ad file. It waits for decision D2 of inflexa-ai/himmel#111.
- No shape of a table in the list. The preview gives the column count.
- No public route for the origin read.
- No change to the TUI file picker or to a cli fetcher.
- No preview of a compressed file. A `.csv.gz` file gives `card`.

## Decisions

### D1. The entry type moves to `type`, and `kind` is the kind of the file

The issue gives `kind` to the kind map of the `fs` routes. The picker entry of Flamme also uses `kind` for the kind of a file, beside a separate folder flag. Thus the entry keeps the name `FolderEntryView`, and these fields change:

- `type: FolderEntryType`: the old field `kind`. The wire type `FolderEntryKind` becomes `FolderEntryType`, the name of the same set in `src/lib/folder_listing.ts:9`.
- `kind: FileKind | null`: `fileKindOf(name)`. It is `null` for a folder and for a link whose `targetKind` is `folder`.
- `itemCount: number | null`, `isInput: boolean`, `origin: FileOrigin | null`, with `FileOrigin = {runId: string; stepId: string}`.

The internal `FolderEntry.kind` of `folder_listing.ts` keeps its name, because the TUI picker reads it and this change does not touch the TUI.

Alternative: keep `kind` for the entry type and add `fileKind`. This contradicts the issue and the field name of the picker. Rejected.

Alternative: rename `FolderEntryView` to `FsEntry`, the name in the issue text. The issue names the existing type at `src/api/fs.ts:23`, and a rename only moves names. Rejected.

### D2. One queue of fixed width reads the facts of the page

The route makes one `PQueue` for each request, with the width `ENTRY_READ_WIDTH = 16`. Each entry of the page is one job: `opts.entryDetails`, then the item count when the entry is a folder or a link to a folder. A slow mount then holds one slot, and a page of 200 entries never has 200 reads in flight. The page slice stays before the queue, thus no entry outside the page gets a read.

The width 16 keeps the throughput of a local disk. A `stat` takes microseconds, and 13 rounds of 16 cost less than the network round trip of the request.

### D3. The item count is one streamed read of the folder

`src/lib/folder_listing.ts` gets two exports:

- `scanFolder(path, hidden, visit)`: one `opendir` of the path, with an async iteration of the entries. It calls `visit` with a `FolderEntry` for each entry after the hidden filter, and it gives the count. It takes no `stat`. The iteration holds a small buffer of entries, thus the memory does not grow with the folder.
- `countFolderEntries(path, hidden)`: `scanFolder` with a `visit` that does nothing.

The errors map as in `readFolder`. `compareEntries` also becomes an export, for D9.

`itemCount` is the count of `countFolderEntries(entry.path, hidden === "true")`. Thus the count obeys the `hidden` value of the request. It is equal to the `total` of a list of that folder with the same value. A failed read gives `null`. A file gives `null` with no read.

Alternative: `readdir`. It holds each name of the folder in memory, and up to 16 large folders can be in flight. Rejected.

### D4. `namePrefix` filters after the folder read

`filterValue(c.req.query("namePrefix"))` reads the value, thus an empty value is no prefix, and the hidden rule of the request applies. With a non-empty prefix, the route reads the folder with the hidden entries, and it keeps each entry whose `name.toLowerCase()` starts with `prefix.toLowerCase()`. A hidden name starts with `.`, thus only a prefix that starts with `.` keeps it. With a prefix, `hidden` has no effect on which entries come back. `hidden` keeps its validation, and it still sets the hidden rule of `itemCount`. `total` counts the entries after the prefix filter.

### D5. `isInput` comes from the canonical input paths, one time for each request

With `analysisId`, the route calls `listAnalysisInputs(analysisId)` and then `inputAbsolutePaths` one time for each request. A `DbError` of `listAnalysisInputs` gives 500 `internal_error`. `inputAbsolutePaths` gives no path for an anchor that it cannot resolve, and such an input marks no entry. Without `analysisId`, the route reads no input, and each entry has `isInput` false.

The route builds two sets one time for each request: the paths of the input files, and the paths of the input folders, from `isDir` of each input. An entry is an input when its path is in one of the sets. It is also an input when a parent folder of it is in the folder set. Thus the cost for each entry grows with the depth of its path, and not with the count of the inputs. A file input never marks a path inside it.

The test uses the path of the entry, which is the canonical folder joined with the name. Thus a link entry whose target is an input is not marked. The cost of a `realpath` for each link is the alternative. Rejected.

### D6. `origin` comes from one ledger read for each page

`fsRoutes` becomes `fsRoutes(boot: ServerBoot, opts)`, as `artifactRoutes(boot, opts)` is. `app.ts` passes `deps.boot`. `FsRouteOpts` gets `artifactOrigins`, with `queryArtifactOrigins` of the harness as the default. A test replaces it, because the real read needs Postgres.

With `analysisId`, and with `boot.runtime()` not `null`, the route does these steps:

1. It locates the canonical workspace root one time for each request. `locateRoot` moves from `artifacts.ts` to `boundary.ts` as the export `locateWorkspaceReadRoot`, and the artifact list imports it from there. A `DbError` gives 500 `internal_error`. `null` gives `origin` `null` for each entry.
2. It changes each entry path of the page that is inside the root, and not equal to it, to the relative form: `relative(root, path)`, with `/` between the parts.
3. It sends one `artifactOrigins` call with these paths, in parallel with the queue of D2. It sends none when no path is inside the root.
4. An entry gets `{runId, stepId}` when its row has both values. An `input` row has no run, thus it gives `null`.

With no runtime, the route sends no read, and each `origin` is `null`. A failed read logs a warning, and each `origin` is `null`. This copies the analysis list: a list with no origin is better than no list. The `fs` routes thus still answer before the runtime boot is ready.

Alternative: 503 `unavailable` with `analysisId` before the boot is ready. The picker then cannot browse an analysis while the server boots. Rejected.

Alternative: derive the step from the path shape `runs/{runId}/{stepId}/`. A file that a step wrote outside its step folder, or a path of that shape that no step wrote, gives a false origin. Rejected.

### D7. One open step serves `fs/read` and `fs/preview`

`files.ts` gets the export `openRealPath(c, opts, roots, target, notAFile)`. It holds the `classifyRealPath` switch of `serveFile`, the open with `OPEN_FLAGS`, and `openFailure`. It gives `Result<{handle, realPath}, Response>`. `serveFile` calls it and then `serveHandle`, thus the read route does not change. The preview calls it with `"unlimited"`.

A folder opens with these flags on Linux and on macOS, and `fstat` of the handle tells a folder from a file. A link that replaces the last part of the real path after the resolve gives `ELOOP`, thus 403. A socket fails the open, and `notAFile` answers.

### D8. The preview route

`GET /preview` reads `path` with `absolutePathOf`, calls `holdConnection`, and calls `openRealPath`. Then it reads the facts of the handle:

- A folder: the route keeps the handle open, and it builds the `folder` member from the real path (D9). A failure of the folder read maps through `readErrorResponse`. After the read, the route takes an `lstat` of the real path, and it closes the handle. A path that is not a folder, or that has a device or an inode different from the facts of the handle, gives 403 `forbidden`.
- Not a regular file (a FIFO, a device): the route closes the handle, and it answers 400 `validation_error`.
- A regular file: the route takes the name of the real path. When `fileKindOf(name)` is `figure`, the route closes the handle, and it gives `{kind: "figure", src, alt}`. `src` is `/api/v1/fs/read?path=` with the encoded real path, relative to the origin of the server. The client resolves it against the base URL of its server. `alt` is the name. Otherwise it reads the head of the file (D10), and it closes the handle.

The member describes the file that the route read, thus the name of the real path gives the kind, and `src` carries the canonical path.

Node has no read of a folder through an open handle. Thus the route reads the folder by its real path. The `lstat` after the read makes sure that a link did not replace the folder. A link that replaces the folder and goes away again during the read stays possible. The `fs` routes have no root limit, thus the client can list such a target directly. The risk is accepted.

The query value `analysisId` gets the guard of the router, and it does not change the preview.

### D9. The folder member is one streamed read with a bounded name list

The route calls `scanFolder(realPath, false, visit)`. `visit` adds 1 to the count of the kind of the entry: `folder` for the type `folder`, and `fileKindOf(name)` for each other entry. A `null` kind counts in `items` only. `visit` also keeps the first `FOLDER_PREVIEW_NAMES = 10` entries in the order of the list: it inserts an entry in a sorted array with `compareEntries`, and it drops the last entry when the array holds 11. The memory thus does not grow with the folder.

The member is `{kind: "folder", items, kinds, names}`:

- `items`: the count of the entries that are not hidden.
- `kinds`: `{kind, count}` for each kind with a count above 0. `folder` is first, then the order of `FILE_KINDS`. `src/api/fs.ts` gets `FILE_KINDS` as a constant, and `FileKind` comes from it.
- `names`: `{name, dir, kind}` for each kept entry. `dir` is true for the type `folder`. `kind` is `null` for a folder.

A link to a folder counts as a file of its name, because the read takes no `stat`.

### D10. The head of a file gives `table`, `text`, or `card`

`FsRouteOpts` gets `previewBytes`, 64 KiB in production. A test sets a small value. The route reads up to `previewBytes + 1` bytes from offset 0, in a loop that stops at the end of the file. More than `previewBytes` bytes means a cut head, and the route drops the extra byte. Otherwise the head holds the full file.

The route classifies the head in this order:

1. A NUL byte gives `{kind: "card", format}`.
2. A UTF-8 decoder in fatal mode decodes the head. For a cut head, the decoder runs in stream mode, thus it drops an incomplete character at the end. A decode failure gives `card`. A NUL byte alone misses a Latin-1 file and a PDF file with the usual binary comment line, and the decode catches them. A PDF head with only ASCII bytes gives `text`.
3. The text of a cut head ends at its last line end. A cut head with no line end keeps all its decoded text. A head holds the full header record when it holds the full file, or when it holds a line end outside double quotes.
4. The header is the first record: the text before the first line end outside double quotes. When `fileKindOf(name)` is `table`, the head holds the full header record, and the header holds a tab or a comma, the member is `table`. The separator is the tab when the header holds one, and the comma otherwise. `columnCount` is the count of the fields of the header. A separator inside double quotes does not split a field. `rowCount` is the count of the records after the header record when the head holds the full file, and `null` otherwise. A line end inside double quotes does not end a record. An empty last line does not count.
5. Each other head gives `{kind: "text", language, code}`. `language` comes from the extension of the name in lower case, through this map of ids of the Shiki highlighter that Flamme uses. Each other extension gives `text`.

   | Extension | `language` |
   | --- | --- |
   | `py` | `python` |
   | `r` | `r` |
   | `sh` | `bash` |
   | `toml` | `toml` |
   | `json`, `ipynb` | `json` |
   | `md` | `markdown` |
   | `yaml`, `yml` | `yaml` |
   | `csv` | `csv` |
   | `tsv` | `tsv` |
   | `log` | `log` |

`format` of `card` is the extension of the name in lower case, or `null` for a name with no extension. The label is the work of the client, as for `FileKind`.

Thus a `.txt` or a `.csv` file with no separator in its header gives `text`. A `.xlsx`, a `.parquet`, and a `.csv.gz` file give `card`.

### D11. The preview union is a wire type

`src/api/fs.ts` gets `FilePreview`, a union on `kind`, with one type for each member: `TablePreview`, `TextPreview`, `FigurePreview`, `FolderPreview`, and `CardPreview`. The field names copy the union of the picker in inflexa-ai/himmel `packages/ui/src/components/pickers/quick-look.tsx:40`. The changes are `columnCount` and `rowCount` in `table`, and `{kind, count}` objects in place of tuples in `kinds`. Also `names` can hold a `null` kind, and `card` can hold a `null` format. inflexa-ai/himmel#143 aligns the picker.

### D12. The code stays in the files of its callers

The preview helpers have one caller, thus they stay in `fs.ts`, by the rule of `cli/CLAUDE.md`. `scanFolder`, `countFolderEntries`, and `compareEntries` stay in `folder_listing.ts`, beside `readFolder`. `locateWorkspaceReadRoot` and `contains` move to exports of `boundary.ts`, because each gets a second caller.

## Risks / Trade-offs

- [The item count reads each name of a child folder] → The memory stays bounded (D3), and the queue bounds the reads in flight. The time grows with the size of the child folders. The issue asks for the count, and no bound keeps an exact count.
- [The folder preview reads each name of the folder] → The same bound as D3. The name list holds 10 entries.
- [A failed ledger read gives `null` origins with no signal to the client] → The warning goes to the log. The analysis list makes the same choice.
- [A link entry to an input is not marked] → D5 names the cost of the alternative.
- [The list takes the kind of a link from its own name. The preview takes it from the name of the target] → Each describes what it read. A disagreement of the two extensions is rare.
- [Flamme reads `kind` as the entry type today] → Flamme moves in inflexa-ai/himmel#143. No alias, by the decision of the issue.

## Migration Plan

No data changes. A client reads the entry type from `type`, and the kind of a file from `kind`. The harness must be on npm with `queryArtifactOrigins`, and the cli pin must name that version, before a cli release.
