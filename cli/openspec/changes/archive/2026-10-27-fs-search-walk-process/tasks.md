# Tasks

## 1. The protocol and the child

- [x] 1.1 Add `src/modules/fs/walk_child.ts` (D2): the record encoder with a 1 MiB buffer, `decodeRecords` with a carry, and `walkToRecords(scope, opts, read, write)` with the walk rules (width, depth, hidden, no symbolic link entry, skipped unreadable folder, the scope error record, the scope-landed record, and the end record). Make sure that `src/modules/fs/walk_child.test.ts` passes. The tests pin:
  - the round trip of a temp tree: the decoded records give the same entries, parents, types, and names as an in-process build
  - the error record of an absent scope, and of a scope that is a file
  - a record split across two chunks
- [x] 1.2 Add the hidden command `inflexa server walk <scope> [--hidden] [--depth <n>] [--width <n>]` to `src/cli/index.ts` (D1, D6): kind `standalone`, policy `blocked` with its reason, `{ hidden: true }`. The action runs `walkToRecords` with `Bun.write(Bun.stdout, bytes)` for each buffer, exits on a write error, and exits when `process.ppid` is 1 on an `unref` interval. Add the row to the three tables of `src/cli/agent_policy_tree.test.ts`. Make sure that `bun run test src/cli/agent_policy_tree.test.ts` and `src/cli/agent_policy.test.ts` pass, and that `inflexa server --help` lists no `walk`. Make sure that `bun scripts/gen_docs.ts` emits no page for `server walk` (run it as a plain script, never under `bun test`).

## 2. The parent

- [x] 2.1 Add `NameIndex.addBytes` (D3) and the `WalkChild`, `WalkSpawner`, and `WalkSpawnError` types with the production spawner in `src/modules/fs/search_index.ts` (D4). Replace `ReadEntries` and the in-process read of `createWalk` with the stream reader: each record is one insert, the caps and the deadline stay in the parent, and a cut, an eviction, or `stop()` kills the child once and cancels the reader without a wait on the exit. Add `maxWalkChildren: 4` and the FIFO queue (D5). Make sure that `src/modules/fs/search_index.test.ts` passes with the in-process spawner helper (D7). The new tests pin:
  - the budget kills a child that never writes, and the search answers `truncated` true
  - the entry cap kills, and the index holds at most the cap
  - an eviction kills, and `stop()` kills each child
  - the queue: with a bound of 1, the second walk starts after the first child ends, and its search answers `truncated` true before that
  - a failed spawn gives `spawn_failed`
  - a scope error record gives the `FolderReadError` with its `code` and message
  - a stream that ends before the end record leaves the index truncated

## 3. The route

- [x] 3.1 Replace `FsRouteOpts.readEntries` with `spawnWalk` (default: the production spawner) and map `spawn_failed` to 500 `internal_error` in `src/server/routes/fs.ts`. Adapt the search tests of `src/server/routes/fs.test.ts` to the in-process spawner. Make sure that the file passes. The new tests pin:
  - `/list` answers while a walk child never writes, and the budget kills that child
  - a failed spawn gives 500
- [x] 3.2 Add one real-child test that spawns the command through `selfInvocation` with `env: Bun.env` on a temp tree and searches it. Make sure that it passes under `bun run test`.
- [x] 3.3 Run `bun run format:file` on each changed file in `src/`. Make sure that `bun run typecheck` and `bun run lint` pass.

## 4. The measurements and the suite

- [x] 4.1 Measure with scripts under `tmp/claude/bench/` (never committed) as D8 says: `fd -uu` and the production path on `~/repos` and `~`, 3 runs each, medians and ratios, beside the in-process numbers of the earlier change. Record the numbers in the final report.
- [x] 4.2 Run the full cli suite one time with `cd cli && bun run test`. Make sure that it passes.
