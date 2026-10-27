# Tasks

## 1. The pool of the server

- [x] 1.1 Add to `src/lib/env.ts`: `fsPoolVar`, `serverFsPoolSize(cores)`, `fsPoolSize()`, `serverChildEnv(base)`, and remove `fsPoolVar` in `walkChildEnv` (D1). Make sure that new tests in `src/lib/env.test.ts` pass. The tests pin:
  - `serverFsPoolSize(2)` is 64 and `serverFsPoolSize(32)` is 128
  - `serverChildEnv` keeps a value of the base, and sets the size when the base has none
  - `walkChildEnv` gives no `fsPoolVar` when the base holds it
- [x] 1.2 Pass `env: serverChildEnv(undefined)` in `spawnDetachedServer` (D2), and log `fsPoolSize()` in the start line of `runServe` (D4). The spawn becomes a field of the serve options with `Bun.spawn` as its production value. Make sure that a test in `src/server/serve.test.ts` reads the `env` of the injected spawn, and that the file passes.
- [x] 1.3 Move `selfInvocation` to `src/lib/self_invocation.ts` (imports `env.ts` only) and update each importer. Add `src/lib/fs_pool_reexec.ts` with `ensureServerFsPool(argv, execve, env)` (D3), and import it first in `src/index.ts`. Make sure that unit tests pass for: `["serve"]` calls `execve` with the variable and `selfInvocation`, `["serve", "--detach"]`, `["serve", "--run-detached"]`, `["ls"]`, and an environment with the variable do not call it, and `win32` does not call it.
- [x] 1.4 Add the proof test (D6): a fixture that holds the larger of 16 and 2 times the core count of FIFO opens in a child started with `serverChildEnv(Bun.env)`, then reads a folder within 2 s; and a control child with neither `UV_THREADPOOL_SIZE` nor `GOMAXPROCS` blocks. `test.skipIf` on Windows. Make sure that it passes.
- [x] 1.5 Rewrite the comment of `METADATA_WIDTH` in `src/modules/staging/staging.ts:140-145`: under the server a hung tree holds its threads and the large pool keeps threads for the other calls, and under a person-run `inflexa run` the default pool has no such reserve. Make sure that `bun run lint` passes.

## 2. The self-started children

- [x] 2.1 Add `src/lib/child_flags.ts` with the five constants and `isSelfStartedChild(args)` (D5). Move each constant from its module and update each importer and the registry; drop `isWalkChildInvocation` if no caller remains. Gate the update read in `src/index.ts` on the predicate. Make sure that `src/lib/child_flags.test.ts` pins each child argv and `["ls"]`, and that `src/server/serve.test.ts`, `src/modules/fs/walk_child.test.ts`, and the transfer and store tests pass.

## 3. The checks, the bench, and the suite

- [x] 3.1 Run `bun run format:file` on each changed file in `src/`. Make sure that `bun run typecheck` and `bun run lint` pass.
- [x] 3.2 Write the bench under `tmp/claude/bench/` (never committed): the real foreground `serve` with a temp data folder, and read the pool size from its start line; `pool.ts` under `serverChildEnv` against the default; and the walk child env check. Record the numbers in the final report.
- [x] 3.3 Run the full cli suite one time with `cd cli && bun run test`. Make sure that it passes. Then remove the three entries from `tmp/claude/SESSION.md`.
