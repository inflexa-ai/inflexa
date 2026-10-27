# Design

## Context

- `createWalk` (`src/modules/fs/search_index.ts:412-530`) reads folders in the server process through `ReadEntries` (`:53`), with `width` reads in flight, the caps at each insert, and a deadline timer. `createSearchIndexCache` (`:550`) owns the map, the TTL, the LRU eviction, `maxIndexes`, and `stop()`. The route builds the cache from `FsRouteOpts.search`, `now`, and `readEntries` (`src/server/routes/fs.ts:60-91`, `:488`).
- Bun runs each async `node:fs` call on one process-wide pool of blocking threads, sized by the core count. Twelve hung `open` calls on a 12-core machine block each other async file call of the process (`tmp/claude/bench/pool.ts`). A bigger pool is slower on `~/repos`: 4.2 s at pool 128 against 3.4 s at the default.
- `selfInvocation` (`src/lib/cli.ts:39`) gives the argv of this CLI: `bun` plus the source entry in a development build, the binary in a release. `serve --run-detached` (`src/cli/index.ts:418`) and `sandbox pull --run-transfer` (`:966`) are the hidden entry points of a child that the CLI starts.
- `Bun.spawn` with `stdout: "pipe"` gives a `ReadableStream`. After `kill(9)` the reader of the parent ends at once, with no wait on `exited` (`tmp/claude/bench/kill_probe.ts`). A child that writes to a pipe whose reader is gone gets `EPIPE` on the write.
- No test in cli stands in for a child of the search. The walk tests inject `ReadEntries` (`src/modules/fs/search_index.test.ts:43-66`), and one route test overrides `readEntries` over a real listener (`src/server/routes/fs.test.ts:1263`).
- The prototype (`tmp/claude/bench/child.ts`, `parent.ts`) streams `u32 parent, u8 flags, u16 length, name bytes` in 1 MiB buffers. Measured, medians of 3: `~/repos` fd 3.22 s, in-process 3.41 s, child 3.70 s. `~` fd 6.89 s, in-process 8.72 s, child 9.03 s.
- `agent_policy_tree.test.ts` holds literal tables of each command, hidden or not (`:48-232`). A new command is added to the three tables by hand.

## Goals / Non-Goals

**Goals:**

- A hung mount stalls one walk child, and no other request of the server.
- The cost of the child stays close to the in-process walk: the stream adds no string for each entry on either side.
- Each kill is immediate and never waits. A child that cannot die holds nothing of the server.

**Non-Goals:**

- No change to the search route contract, the score, the heap, the enrichment, the caps, the TTL, or the LRU rules.
- No change to the pool size of the server.
- No retry of a failed child.

## Decisions

### D1. The child is `inflexa server walk <scope> [--hidden] [--depth <n>] [--width <n>]`

The command is a hidden subcommand of the `server` group, registered through `registerAction` with the kind `standalone` and the policy `blocked`. The reason of the policy: only the local server starts it, and it streams a binary protocol on stdout. `commander` hides it with `{ hidden: true }` on `.command()`. The three policy tables of `agent_policy_tree.test.ts` get its row, and the `agent-cli-tool` spec names it.

Alternative: a hidden flag on `serve`, as `--run-detached`. Rejected: the walk is a read-only stream, and `serve` runs the server, thus one command would carry two effect classes.

### D2. The record protocol

The child writes records to stdout. Each record starts with one tag byte:

- `0`, an entry: `u32 parent` (little-endian, the index of the parent entry), `u8 type` (0 file, 1 folder, 2 symbolic link), `u16 length`, then the UTF-8 bytes of the name.
- `2`, the scope read landed: no payload. The child writes and flushes it at once after the read of the scope, thus the parent resolves the scope wait without a full buffer.
- `3`, the end of the walk: no payload. The child writes it after its last entry, then flushes and exits. A stream that ends without it is an abnormal end (a crash or a kill), and the parent marks the index truncated.
- `1`, a failed scope read: `u8 length` and the ASCII bytes of the errno code, for example `ENOENT`, then `u16 length` and the UTF-8 bytes of the message. Nothing follows it. The parent builds a cause `{code, message}` from it, thus `readError` and `readErrorResponse` keep their mapping and their `details.code`.

Entry 0 is the scope and has no record. The child numbers each entry that it writes in order from 1, and the parent adds each record in order. Thus the index of the parent is the same number on each side. The child does the hidden filter, thus the numbering holds. The parent computes the depth, the hidden bit, and the non-ASCII bit at the insert, from the parent chain and the name bytes. The child enters a folder only when its depth is below `--depth`. A folder record at that depth marks the index truncated in the parent, as today.

The child fills a 1 MiB buffer and writes it when a record does not fit, and at the end. `src/modules/fs/walk_child.ts` holds the walk of the child (`walkToRecords(scope, opts, read, write)`), the `ReadEntries` type with its production read, the encoder, and the decoder (`decodeRecords`). Thus the command, the parent, and the tests share one protocol, and a test injects the read.

The end of the stream after the record `3` is a complete walk. The end of the stream without it leaves the index truncated, and it resolves the scope wait when no scope record came.

### D3. The parent reads the stream into `NameIndex` with no string for each entry

`NameIndex` gets `addBytes(bytes, start, length, parent, kind)`. It copies the name bytes into the pool and sets the hidden bit from the first byte. One pass over the bytes during the copy sets the non-ASCII bit. `add(name, ...)` stays for the tests and for the scope. The decoder keeps a carry of at most one partial record between chunks, thus no record is copied twice.

### D4. The walk of an index is a child handle

`createWalk` becomes: start the child through an injectable `spawnWalk(scope, opts): Result<WalkChild, WalkSpawnError>`, where `WalkChild = { stdout: ReadableStream<Uint8Array>; kill(): void }`. The production spawner calls `Bun.spawn` with `selfInvocation(["server", "walk", scope, ...flags])`, `stdin: "ignore"`, `stdout: "pipe"`, `stderr: "ignore"`, then `unref()`. A throw of `Bun.spawn` maps to `{ type: "spawn_failed", cause }`.

The parent reads the stream and inserts each record. The caps of the entry count, the total, and the time budget stay in the parent, at each insert and in the deadline timer. A cut, an eviction, or `stop()` calls `kill()` once (`kill(9)`) and cancels the reader. The parent never awaits `exited`. The partial index stays in the cache after a cut, marked truncated, as today. A scope error record sets `cached.error` and ends the walk, as the in-process read failure did. A `spawn_failed` sets a walk error that the route maps to 500 `internal_error`.

`SearchIndexCache.search` gives `ResultAsync<SearchResult, FolderReadError | WalkSpawnError>`.

Alternative: keep `ReadEntries` and run it in a `Worker`. Rejected: the pool is process-wide, thus a worker shares the stall.

### D5. The bound on live children is a queue

`SearchLimits.maxWalkChildren = 4`. The bound counts the children that the parent started and still reads: a child releases its slot at the end of its stream or at its kill. A killed child that the kernel holds is not counted, because the parent holds nothing of it. A walk beyond the bound waits in a FIFO queue, and it starts when a slot frees. The index exists in the map from the first search, thus the single flight holds. `startedAt`, the time budget, and the deadline timer start when the child starts, not at the queue entry. A search on a queued walk waits for the start of its child at most `firstWaitMs` from its own call. When the child starts in that time, the search waits for the read of the scope, as each search does, and a scope error keeps its 404, 400, or 403 answer. When the child does not start in that time, the search answers with no entry and `truncated` true, and a later search gets the scope error once the child ran. Thus a search never waits for the budget of another walk. A queued walk that is evicted leaves the queue. `stop()` empties the queue, and a slot that frees after `stop()` starts no child.

Alternative: refuse the search with 503. Rejected: a picker would show an error on a keystroke, and a slot frees within the time budget at the latest.

### D6. The child exits when the parent is gone

The child writes each buffer with `Bun.write(Bun.stdout, bytes)` and exits on its rejection (`EPIPE` when the reader is closed). A `FileSink` writer does not fit: after `EPIPE` it rejects one write, then drops each later write and the walk runs to its end.

The server gives its pid to the child in the variable `INFLEXA_WALK_PARENT_PID`. Before the walk, the child compares `process.ppid` with that pid and exits on a difference. It does the same comparison on an `unref` interval of 1 s. A dead parent reparents the child, thus the values differ.

There is no rule for pid 1. Thus a server that runs as pid 1, for example a container entrypoint, is a normal parent. The first comparison also catches a server that died before the child started. Without the variable, for example in a manual run, the parent at the start is the expected parent. A `kill(9)` needs no comparison.

### D7. Tests

- `walk_child.test.ts`: the round trip of the protocol (encode a tree, decode, compare with an in-process build), the error record, and a record split across chunks.
- `search_index.test.ts`: the tests keep their shape with a fake spawner. The helper `inProcessSpawner(read)` runs `walkToRecords` in the test process with the injected read. It gives a `WalkChild` whose stream carries the records and whose `kill` is a spy. Thus the cap, the deadline, the TTL, the LRU, and the single-flight tests stay. New tests: the budget kills a child that never writes, the entry cap kills, an eviction kills, and `stop()` kills each child. Also the queue of `maxWalkChildren`, and a failed spawn.
- `fs.test.ts`: `FsRouteOpts.spawnWalk` replaces `readEntries`. A route test with a child that never writes proves that `/list` answers during the hang and that the budget kills the child. The disconnect test keeps its shape with the in-process spawner.
- One real-child test spawns the command through `selfInvocation` with `env: Bun.env` on a temp tree and searches it. It pins the command line and the protocol of the binary.

### D8. The measurement protocol

The implementor measures the real route path (the cache with the production spawner) against `fd -uu`. The trees are `~/repos` and `~`, read only, with a warm file-system cache and a fresh cache of indexes for each run, 3 runs each, with scripts under `tmp/claude/bench/`. The report gives the medians, the ratios, and beside them the in-process numbers of the earlier change and the prototype numbers of the context section.

## Risks / Trade-offs

- [A child per scope and `hidden` value, up to 4 live] → each child is one Bun process (about 30 MB RSS) for the time of its walk. It exits at the end of the walk.
- [A development build starts `bun src/index.ts`, which loads the registry] → the start costs about 100 ms before the first read. The release binary is faster.
- [The child inherits the startup environment of the server] → a test passes `env: Bun.env` in its own spawner. The production child needs no variable.
- [`kill(9)` leaves no time for a flush] → nothing to flush: the parent keeps the entries that landed and marks the index truncated.
- [A record split across two chunks] → the decoder keeps a carry, pinned by a test.

## Open Questions

None.
