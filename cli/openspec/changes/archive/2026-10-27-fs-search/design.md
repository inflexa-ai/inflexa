# Design

## Context

- `fsRoutes(boot, opts)` (`src/server/routes/fs.ts:393-492`) mounts `/home`, `/list`, `/read`, and `/preview` behind `analysisQueryGuard` (`:398`). `absolutePathOf` (`:159-172`) validates `path`. `readErrorResponse` (`:370-385`) maps a `FolderReadError` to 400, 403, or 404.
- `/list` enriches the entries of one page: `entryView` (`:88-112`) reads one `stat` plus the item count for each entry, in a `PQueue` of width 16 (`:450-452`). `readOrigins` (`:119-146`) sends one ledger read for the page. The `analysisId` block (`:429-447`) reads the inputs and the workspace root one time for the request.
- `FolderEntry` (`src/lib/folder_listing.ts:12-18`) is `{name, path, kind, hidden}`. `entryView` takes it, thus a hit must become a `FolderEntry` with its full path.
- `subsequenceScore` (`src/lib/fuzzy.ts:17-34`) lowercases the whole target string on each call. `rankBy` sorts each match.
- Under `Bun.serve`, `request.signal` aborts when the client closes the socket mid-request. A probe (`tmp/claude/bench/signal_probe.ts`) confirmed it on Bun 1.4.2.
- No TTL cache with a size bound exists in cli. `rootCache` (`src/modules/analysis/output.ts:169-219`) is a TTL map with no bound.
- Measurements on `~/repos` (1.67M entries, 177K folders, warm cache, Bun 1.4.2, 12 cores), one run each unless noted. `fd -uu` 2.84 s (5 runs, 2.84 to 2.89). A bare walk at width 64: 3.66 s, 128: 3.32 s, 256: 3.24 s. The compact index (names plus parent index) at width 64: 3.39 s, 128: 3.36 s, 256: 3.08 s. Thus the index adds nothing over the bare walk, and width 256 gives 1.08x of `fd`.
- Index memory on the same tree, JS heap after `Bun.gc(true)`: JS string names 172 MB, a UTF-8 byte pool 99 MB, of which 36 MB are arrays sized for 4M entries. The names use 31 MB in the pool, against about 136 MB as strings. A score of one query over the full index: 106 ms with strings, 76 ms over the pool.

## Goals / Non-Goals

**Goals:**

- A keystroke on a built index costs one scan of the names, no allocation for each entry, and one enrichment of at most `limit` hits.
- The walk does not regress the earlier ratios to `fd -uu`: at most 1.17x on `~/repos` and 1.48x on `~`, and lower where possible. The index build adds no measurable time over the bare walk.
- The memory of an index is about 30 bytes for each entry, and the total across indexes has a cap.

**Non-Goals:**

- No scope rule (inflexa-ai/inflexa#750).
- No change to `fs/list`, to the TUI picker, or to a cli fetcher. No consumer of the route exists in this repository.
- No persistence of an index across server restarts, and no watch of the file system for changes.
- No match against the path of an entry. The query matches the name only.

## Decisions

### D1. The index is a name pool with parallel typed arrays

`src/modules/fs/search_index.ts` holds the walker, the index, and the cache of indexes. An index keeps, for each entry `i`:

- the UTF-8 bytes of the name in a pool of chunks (`Uint8Array`), with `starts: Uint32Array` as global offsets and `lengths: Uint16Array`. The first chunk is 64 KiB, and each next chunk doubles the previous one, up to 16 MiB. Thus an empty scope costs about 76 KB, not 16 MiB. Each chunk owns a 16 MiB slot of the offset space, whatever its size. Thus the chunk of an offset is one shift, and the position in it is one mask. A name never crosses a chunk: when a name does not fit, the pool opens a new chunk, and the unused tail of the old chunk stays empty. Thus the end of a name comes from its length, never from the next start.
- `parents: Int32Array`: the index of the parent entry, `-1` for the scope.
- `depths: Uint8Array`: the depth below the scope, which the depth cap and the tiebreak read.
- `flags: Uint8Array`: the type (`file`, `folder`, `symlink`), the hidden bit, and a non-ASCII bit.

The typed arrays grow by doubling, from a small start, thus a small scope costs little. Entry 0 is the scope itself.

The full path of an entry is built from the parent chain, only when a folder read starts and for each hit of a response. The build uses `join` of `node:path`, thus the scope `/` gives `/name` and not `//name`. The measurement above shows this costs nothing visible in the walk.

Alternative: JS strings in an array. Measured at about 80 bytes for each name against 19 bytes in the pool, and 40 percent slower to score. Rejected for memory.

Alternative: one `Uint8Array` that doubles. A doubling copy of a 100 MB pool stalls the event loop. Rejected for chunks.

### D2. A byte-level scorer in `src/lib/fuzzy.ts`

`subsequenceScoreBytes(query: Uint8Array, bytes: Uint8Array, start: number, end: number): number` is the algorithm of `subsequenceScore` over a byte range, with an ASCII fold (`| 0x20` for `A` to `Z`). The query is lower-cased by the caller one time for the request, as bytes. For an ASCII name the result is equal to the string scorer, which a test pins. An entry with the non-ASCII bit takes the slow path: decode the name and call `subsequenceScore`. Thus every name scores with the semantics of the string scorer, and the common case does no allocation. A query that holds a character outside ASCII sends every entry through the string scorer, because the byte fold covers ASCII only.

Alternative: a scorer that folds Unicode in bytes. Needs a case table. Rejected: the slow path covers it exactly.

### D3. The walk is a stack of folder indexes and a fixed count of reads in flight

The walker holds a stack of entry indexes of the folders to read, and `width` (512) reads in flight. A read is `readdir(path, {withFileTypes: true})`. For each dirent it pushes one entry with the type from the dirent. A folder dirent, not a symbolic link, is pushed on the stack when its depth is below the cap. A failed read counts the folder as skipped, and the walk continues. A skipped folder does not mark the index truncated: the walk ended on its own, as `fd` does. The stack is LIFO, thus a walk goes deep first and the stack stays small.

Width 512 comes from the measurements: 1.05x of `fd` on `~/repos` and 1.23x on `~`. Width 256 gave 1.07x on `~/repos` and 1.34x on `~`. Width 64 gave 1.29x on `~/repos`. The width is a field of `SearchLimits`, thus a test can set it to 1 and pin "one read for each folder".

Alternative: `PQueue`, as `walkFiles` in staging. It allocates a promise and a job object for each folder. Rejected for the hot loop. Alternative: `scanFolder` (`opendir`). It allocates an async iterator for each folder. Rejected for the same reason.

Without `hidden`, a hidden dirent is not pushed. Thus the walk does not enter a hidden folder, and the index of `hidden=false` holds no hidden entry.

### D4. One index for each canonical scope and `hidden` value, with a single-flight walk

The cache is a `Map` from `${canonical}\0${hidden}` to an index. The route resolves the canonical scope with `realpath` first. Then `search(canonical, hidden, query, limit)` finds or makes the index. The first call inserts the index in the map and starts the walk, before any `await`. Thus a concurrent first request finds that index, and the two share one walk and one read of the scope.

The walk reads the scope itself as its first folder. A failure of that read is stored on the index as its `FolderReadError`. The index is removed from the map, and each waiter of that walk gets the error. The route maps it through `readErrorResponse`, as the list does. A `realpath` failure maps the same way, before the cache.

The cache lives in the closure of `fsRoutes`, as `identity` does. Thus each `fsRoutes(...)` of a test has its own cache, and the one server has one cache. `FsRouteOpts` gets `search: SearchLimits` and `now: () => number`, thus a test sets small caps, a short TTL, and a fake clock.

### D5. A search waits for the walk at most 500 ms, then scores

A search on an index whose walk runs waits for the end of the walk. The wait ends at the latest `firstWaitMs` (500 ms) after the start of the walk. Then it scores. A search always waits for the read of the scope itself, thus a failed scope read gives its error and never an empty result. Thus a small scope answers complete, with `truncated` false, in one request. A large scope answers at 500 ms with the entries so far and `truncated` true. A later search during the walk finds the start older than 500 ms, thus it scores at once. The wait never delays a later keystroke.

The wait is a promise that the walk resolves at its end, raced with a timer that the route clears after the race.

Alternative: answer at once. The first keystroke on any scope would give an empty list. Rejected.

### D6. The score keeps the best `limit` hits in a binary heap

The score scans entries 1 to `count` (the count at the start of the scan). It keeps the best `limit` hits in a min-heap over `(score, depth, index)`: the worst kept hit is at the root, and an entry replaces it only when the entry is better. Better is a higher score, then a lower depth, then a lower code-unit name. The name compare runs only on a tie of score and depth, and it decodes the two names. At the end the heap is sorted, best first. The scan allocates nothing for an entry that does not reach the heap.

The empty query scores 0 for each entry, thus the result is the `limit` shallowest entries in name order.

Alternative: collect each match and sort. Over 1.6M entries a query of one letter matches most names, and the sort costs more than the scan. Rejected.

### D7. The hits are enriched through `entryView` and `readOrigins`

The index gives a `FolderEntry` for each hit: the full path from the parent chain, the name, the kind from the flags, and the hidden bit. Then the route runs the `analysisId` block of `/list` (inputs, workspace root, `readOrigins` for the hits) and `entryView` in a `PQueue` of width `ENTRY_READ_WIDTH`. That block becomes a function that `/list` and `/search` share, with the page entries or the hit entries as its argument. `subpath` is the path of the parent relative to the scope, built from the same chain.

### D8. The caps

`SearchLimits` holds, with these production values in `DEFAULT_SEARCH_LIMITS`:

- `width: 512`
- `maxDepth: 64`
- `maxEntries: 4_000_000` for one index
- `maxTotalEntries: 8_000_000` across indexes
- `walkBudgetMs: 60_000`
- `ttlMs: 120_000`
- `firstWaitMs: 500`
- `maxIndexes: 16`

At about 30 bytes for each entry, one index of 4M entries costs about 120 MB, and the total cap about 250 MB. `~` (3.21M entries) fits in one index. The depth cap also bounds the parent chain of a path. The time budget bounds a walk on a slow mount. The insert of each entry does a check of the entry caps. Thus the index never holds more than `maxEntries`, and the total never exceeds `maxTotalEntries`. After a cap, the walker pushes no folder, and it drops each dirent of a read that lands later. The walk ends when its in-flight reads settle. The time budget does its check at each read start and at each read end. A timer with `unref` also cuts the walk at `walkBudgetMs` after its start. Thus a read that never settles cannot keep a walk open without a bound. The timer stops when the walk ends or stops. A search never waits for the drain: it scores the `count` at that time. A cap marks the index truncated, and the mark stays for the life of the index.

### D9. Eviction: a TTL on the last use, and the least recently used index first

Each index records the time of its last search. The cache holds one `setTimeout` with `unref`, armed for the earliest TTL expiry among its indexes, and armed again after each search. When it fires, the sweep removes each index whose last use is older than `ttlMs`, and it stops the walk of a removed index. Thus an idle index leaves memory at its TTL, with no further request. The same sweep runs at each `search` call, thus a test with a fake clock needs no timer.

Before a new index starts, the cache removes the least recently used indexes. It stops when `total + maxEntries <= maxTotalEntries` and the count of indexes is below `maxIndexes`, or when the new index is the only one. The index count cap bounds the memory of many small scopes, which the entry count alone does not. During a walk, when the total across indexes reaches `maxTotalEntries`, the walk stops with `truncated`.

A `stop()` of the cache clears the timer and stops each walk. A test calls it in its `afterEach`.

Alternative: a sweep only at a call. Rejected: an idle index would stay past its TTL until the next search.

### D10. A client disconnect does not stop the walk

The walk belongs to the index. A picker aborts the in-flight request at each keystroke, thus a walk that stopped on a disconnect would restart on each keystroke and never complete. The route reads `c.req.raw.signal` for nothing. A disconnect ends only the response. The walk stops at a cap, at the end of the scope, or at an eviction. The TTL bounds the memory of an index that no search uses again.

### D11. The route

`GET /search`: `absolutePathOf`, the `hidden` validation of `/list`, `q` through `filterValue` (absent is empty), `limit` through `parseCount(value, 50, 200)`, `holdConnection(c)`. Then `cache.search(...)`. A `FolderReadError` of the scope maps through `readErrorResponse`. The wire type `FsSearch = {hits: FsSearchHit[], truncated: boolean}` and `FsSearchHit = {entry: FolderEntryView, subpath: string}` go in `src/api/fs.ts`.

### D12. The measurement protocol

The implementor measures with scripts under `tmp/claude/bench/` that import the module, and never commits them. On `~/repos` and on `~`, warm cache, the same session, at least 3 runs each of `fd -uu . <tree> | wc -l` and of the walker: the median of each, the ratio, and the two entry counts. Also: the heap and the RSS before and after one index, and the time of one query over the full index. Also the walk time with the index against the bare walk of `tmp/claude/bench/walk2.ts`. The target is no regression of the earlier ratios: at most 1.17x of `fd` on `~/repos`, and at most 1.48x on `~`. Lower is the aim where a lever gives it. The report names each lever tried (width, the chunk size, the path build) and its effect.

## Risks / Trade-offs

- [A walk of `/` or of a network volume] → the depth cap, the entry cap, and the time budget stop it. `truncated` tells the picker. The scope rule stays open in #750.
- [The index is a snapshot, thus a new file does not appear until the TTL] → documented in the spec through `truncated` and the TTL. A later change can add an explicit refresh.
- [Width 512 on a slow disk or a mount] → the walk still bounds its reads to 512 in flight. A test pins the width with a stub.
- [The pool holds names of a scope the user left] → the TTL of 120 s removes it, and the total cap bounds the worst case.
- [The score scans while the walk appends] → JS is single-threaded, thus a scan reads a consistent prefix: it reads `count` one time and scans up to it.
- [A name longer than a chunk] → a name is at most 255 units on each supported file system, thus at most 765 bytes, far below the 64 KiB first chunk.

## Open Questions

None. The cap values are constants in `DEFAULT_SEARCH_LIMITS`, and a later change can tune them without a change to the specs.
