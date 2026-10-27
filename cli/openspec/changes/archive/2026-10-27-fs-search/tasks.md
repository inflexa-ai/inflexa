# Tasks

## 1. The byte-level scorer

- [x] 1.1 Add `subsequenceScoreBytes(query, bytes, start, end)` to `src/lib/fuzzy.ts`. It is the algorithm of `subsequenceScore` with an ASCII fold. Make sure that new tests in `src/lib/fuzzy.test.ts` pass. The tests pin these facts:
  - equality with the string scorer over a set of ASCII names and queries
  - the `-1` reject
  - the empty query

## 2. The walker, the index, and the cache

- [x] 2.1 Add `src/modules/fs/search_index.ts` with the index (D1, D8). Make sure that a unit test inserts names across a chunk boundary and reads each back. The index holds:
  - the `SearchLimits` type and `DEFAULT_SEARCH_LIMITS`
  - the chunked name pool with `starts`, `parents`, `depths`, and `flags`
  - the `pathOf(i)` and `subpathOf(i)` builders
  - the non-ASCII flag at insert
- [x] 2.2 Add the walker (D3). Make sure that tests on a temp tree pass. The walker has a stack of folder indexes and `width` reads in flight with `readdir(withFileTypes)`. It does not enter a symbolic link, it skips an unreadable folder, and it obeys the hidden rule. It stops at the depth, entry, total, and time caps. The tests pin:
  - the entry count and the kinds
  - the skipped folder, and the link not entered
  - each cap with `truncated`
  - a width of 1 that gives one read for each folder, through a stub of the read
- [x] 2.3 Add the score (D2, D6). Make sure that tests pass. The score is one scan of the index with the byte scorer, and the slow path for a non-ASCII name. A min-heap keeps `limit` hits ordered by score, depth, and name. The tests pin:
  - the order and the tie rules
  - the empty query
  - a non-ASCII name that matches with the string semantics
  - a `limit` below the count of matches
- [x] 2.4 Add the cache (D4, D5, D9). Make sure that tests on a fake clock pass. The cache keeps one index for each canonical scope and `hidden` value. It has the single-flight walk and the wait of at most `firstWaitMs`. It has the TTL sweep at each call, the least-recently-used eviction before a new index, and `stop()`. The tests pin:
  - a second search reads no folder
  - two concurrent searches read each folder one time
  - the TTL eviction by the timer with no later search, and the TTL sweep at a call
  - the total-cap eviction, and the index-count eviction
  - the stop of an evicted walk
  - a search that returns during the walk, while the walk continues to its end
  - the first search waits at most `firstWaitMs`, and a later search during the walk answers at once

## 3. The route

- [x] 3.1 Add `FsSearch` and `FsSearchHit` to `src/api/fs.ts`. Make sure that `bun run typecheck` passes.
- [x] 3.2 Lift the `analysisId` block and the `entryView` queue of `/list` into one function that takes the entries to enrich (D7). Make sure that `src/server/routes/fs.test.ts` passes unchanged.
- [x] 3.3 Add `GET /search` to `fsRoutes` (D11), and add `search` and `now` to `FsRouteOpts`. Make sure that new route tests in `src/server/routes/fs.test.ts` pass. The route reads the `path`, `hidden`, `q`, and `limit` values, and it calls `holdConnection`. It reads the scope with `readErrorResponse` on a failure. It searches the cache of the closure, builds a `FolderEntry` for each hit, runs the shared enrichment, and gives `subpath`. The tests cover each scenario of the spec:
  - the nested hit, the folder hit, and the hidden rule
  - the best hits, and the one ledger read
  - the `limit` default, the fallback for a bad value, and the maximum of 200
  - the facts for the hits only
  - the errors, and the analysis guard
- [x] 3.4 Run `bun run format:file` on each changed file in `src/`. Make sure that `bun run typecheck` and `bun run lint` pass.

## 4. The measurements

- [x] 4.1 Write the measurement scripts under `tmp/claude/bench/`, never in the repository. The scripts import `search_index.ts`. Make sure that the protocol of D12 runs on `~/repos` and on `~`. Record the numbers and each lever tried (width, chunk size, path build) in the final report. The protocol gives:
  - the median of at least 3 runs of `fd -uu` and of the walker, and the ratio
  - the entry counts of the two
  - the heap and RSS before and after the index
  - the time of one query over the full index
  - the walk-only time against the walk-plus-index time
- [x] 4.2 Run the full cli suite one time with `cd cli && bun run test`. Make sure that it passes.
