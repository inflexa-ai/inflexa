# Design

## Context

`inputViews` (`cli/src/server/routes/analyses.ts:657-660`) builds each `InputView` from the stored row and from `inputAbsolutePaths` (`cli/src/modules/analysis/input.ts:108`). The places route gives a size from `entryDetails` (`cli/src/lib/folder_listing.ts:147-170`), which uses one `statResultAsync` that follows links (`cli/src/lib/fs.ts:100`). The places route gives a kind from `fileKindOf` (`cli/src/modules/fs/file_kind.ts:147`). The same file already holds a queue of fixed width for its disk reads: `mapBounded` with `DISK_READ_WIDTH` 8 (`cli/src/server/routes/analyses.ts:78-84`).

## Goals / Non-Goals

**Goals:**

- Give `size` and `kind` on each `InputView`, from one `stat` for each input.
- Keep the disk reads of one response in a queue of fixed width.

**Non-Goals:**

- No change to the places route, to `entryDetails`, or to the harness.
- No modified time, mode, or link facts on an input. The issues ask for the size and the kind only.

## Decisions

### D1. One `stat` for each input, in `inputViews`

`inputViews` runs `statResultAsync` on each absolute path through `mapBounded`, thus at most `DISK_READ_WIDTH` reads are in flight. The `stat` follows links, as the `stat` of `entryDetails` does. A folder gives `size` `null`. A failed `stat` gives `null` and the response still answers. An input with no absolute path gets no `stat`.

`entryDetails` is not reused. It takes a `FolderEntry` and it also reads a link and the access bits, which an input does not show.

`inputViews` keeps its direct imports, as `refuseMissing` imports `pathsExistAsync` directly. No new option goes on `AnalysisRouteOpts`, because a test can make each case with real files in a temporary folder.

### D2. The kind comes from the name of the stored path

`kind` is `fileKindOf` of the last segment of the stored `path`. `fileKindOf` is the one map of the server: the folder list and the artifact list route use it too (`cli/src/server/routes/fs.ts:232`, `cli/src/server/routes/artifacts.ts:122`). The harness artifact ledger classifies a file by its folder, and this change does not use that classification. The stored name is the name that the person added. The canonical absolute path resolves each link, and a link can carry a name with no extension. An input that the `stat` reports as a folder gets `null`. When there is no `stat`, the stored `isDir` decides. Thus a missing file keeps the kind of its name.

### D3. Each response that sends an `InputView` carries the two fields

`InputView` is one wire type, and `inputViews` builds it for `GET`, `POST`, and `PUT {A}/inputs` and for `POST {A}/inputs/remove`. The fields are required on the type, thus a second shape of an input does not appear.

## Risks / Trade-offs

- A page of 200 inputs costs 200 `stat` calls, after the canonical-path reads of `inputAbsolutePaths`. The width keeps the reads bounded, and `perPage` bounds the count.
- A removed input that still exists on disk reports its size. That is correct, because the response describes the input that the request removed.
