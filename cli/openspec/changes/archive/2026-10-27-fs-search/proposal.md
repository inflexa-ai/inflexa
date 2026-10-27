# Proposal

## Why

The Flamme file picker (inflexa-ai/himmel#111) searches a scope by name with each keystroke, and no route of the local server searches below one folder. A walk of `~` takes seconds (3.21M entries, 9.8 s in the first measurement). Thus the server walks a scope one time, and it scores each later keystroke against an index in memory.

## What Changes

- Add `GET /api/v1/fs/search?path=&q=&limit=&hidden=&analysisId=`. It gives `{hits: {entry, subpath}[], truncated}`. `entry` is the `FolderEntryView` of `fs/list`, with the same enrichment (`kind`, `itemCount`, `isInput`, `origin`), and `subpath` is the parent path of the hit relative to the scope.
- Add a walker and a name index in `src/modules/fs/`: one index for each canonical scope and `hidden` value, with a name and a parent index for each entry and no full path string. The walk reads folders with `readdir(withFileTypes)` in a queue of fixed width, and it takes no `stat`. It does not enter a symbolic link, and it skips an unreadable folder.
- The first search of a scope starts the walk. A concurrent search of the same scope shares the walk. A search during the walk scores the entries so far and sets `truncated`.
- Caps: depth, entries for each index, entries across all indexes, and a time budget for each walk. A TTL evicts an idle index, and the total cap evicts the least recently used index.
- Score with the subsequence contract of `src/lib/fuzzy.ts`, through a byte-level scorer over the name pool. Keep only the best `limit` hits with a bounded selection. Enrich only the returned hits, with one ledger read for the batch.
- No scope rule: the reach of a host search is open in inflexa-ai/inflexa#750. The caps apply to each scope.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: a new requirement for the search route, its caps, its index, and its errors.
- `fuzzy-scoring`: a byte-level form of the subsequence scorer with the same match-or-reject contract.

## Impact

- `src/server/routes/fs.ts`: the new route beside `/list`, and the reuse of `entryView` and `readOrigins` for the hits.
- `src/modules/fs/search_index.ts` (new): the walker, the index, and the cache of indexes.
- `src/lib/fuzzy.ts`: the byte-level scorer.
- `src/api/fs.ts`: the wire type of the search body.
- No new dependency. No TUI change: no TUI code calls a route under `/api/v1/fs` (the picker imports `readFolder` directly).
