# Proposal

## Why

Each async `node:fs` call of a Bun process runs on one small pool of blocking threads: one thread for each core on POSIX, and 4 threads of the libuv pool on Windows. A call on a hung mount holds its thread forever. The staging walk keeps 16 calls in flight, the folder list reads 16 entries at one time, and each `fs/read` holds an open. Thus one hung mount can trap each thread of the server, and then each async file call of the server blocks. That includes the file routes, the staging, and the logs. The children that the CLI starts for itself also read the update check at each start. In a release build that sends one request to GitHub for each child.

## What Changes

- The server process runs with a large file pool. `UV_THREADPOOL_SIZE` is the larger of 64 and 4 times the core count, unless the environment already sets it. Bun clamps the value to 2 to 1024.
- `inflexa serve --detach` passes the value in the environment of the detached child. The foreground `inflexa serve` runs itself again with the value through `process.execve`, before its first file call, on POSIX. On Windows the foreground server keeps the default pool, and the detached start passes the value. The design names the choice.
- The walk child of `fs/search` keeps the default pool: a large pool makes a walk about two times slower.
- The comment of the staging width tells the truth: under the server, a hung tree holds its threads, and the large pool keeps threads for the other calls. Under a person-run `inflexa run`, the process keeps the default pool, and the comment names that limit.
- One predicate names each child that the CLI starts for itself: the detached server, the transfer children, the flush child, and the walk child. The update check does not run in such a child.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the file pool of the server process, and the pool of the walk child.
- `cli-core`: the update check does not run in a child that the CLI starts for itself.

## Impact

- `src/lib/env.ts`: the readers of the pool variable, the server child environment, and the walk child environment without the variable.
- `src/server/serve.ts`: the detached child gets the environment; the foreground serve runs itself again.
- `src/index.ts`: the re-execution before the first file call, and the update gate through the shared predicate.
- `src/lib/child_flags.ts` (new): the flags of each self-started child and the predicate, imported by `serve.ts`, `transfers.ts`, `store_download.ts`, `store.ts`, `walk_child.ts`, and the registry.
- `src/modules/staging/staging.ts`: the comment of `METADATA_WIDTH`.
- `src/lib/self_invocation.ts` (new): `selfInvocation` moves here from `src/lib/cli.ts`, with each importer updated (`server/serve.ts`, `client/server.ts`, `modules/libs/transfers.ts`, `modules/fs/search_index.ts`, `tui/hooks/boot.ts`, and the tests).
- No new dependency. No change to the behavior of the TUI.
