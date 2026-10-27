# Design

## Context

- Bun runs each async `node:fs` call on one pool of blocking threads. On POSIX the pool reads `UV_THREADPOOL_SIZE`, then `GOMAXPROCS`, then the core count, through `getenv` at its first use, and clamps the value to 2 to 1024. On Windows `open`, `read`, and `write` also run on the libuv pool, 4 threads by default, which reads the same variable.
- Probes on this machine (12 cores, Bun 1.4.2, `tmp/claude/bench/pool.ts`, `pool_inscript.ts`, `execve_probe.ts`): 24 opens that hang on a FIFO block `readdir` with the default pool. With `UV_THREADPOOL_SIZE=64` in the environment of the parent, `readdir` answers in 3 ms. An assignment to `process.env` inside the script before the first file call does not reach the pool on macOS. A `process.execve` of the same script with the variable in the environment works, and Bun 1.4.2 prints no warning for it.
- A large pool slows the walk of a search: on `~/repos`, pool 128 gives 4.2 s at 8 to 12 reads in flight, and 6.7 s at 512, against 3.4 s with the default pool. The walk is in a child process (`src/modules/fs/walk_child.ts`), thus the pool of the server does not touch it, unless the child inherits the variable.
- `spawnDetachedServer` (`src/server/serve.ts:281-304`) passes no `env`, thus the child inherits the environment of the parent. `walkChildEnv` (`src/lib/env.ts:106-108`) spreads `process.env` and adds the server pid. `spawnWalkChild` builds its environment at import time.
- `src/index.ts` evaluates `readConfig()`, the telemetry, the bus, and the provenance recorder at import (`:18-28`). Then it logs the start line (`:65`), starts the update read (`:74`), and parses (`:77`). The update read and the log stream are the first async file calls. `METADATA_WIDTH` (`src/modules/staging/staging.ts:140-145`) says that a hung tree holds "this many threads of the pool, not all", which is false at a width at or above the core count.
- The flags of the self-started children live in four modules: `SERVE_DETACHED_CHILD_FLAG` (`serve.ts:33`), `IMAGE_TRANSFER_FLAG` (`modules/libs/transfers.ts:137`), `CATALOG_TRANSFER_FLAG` (`modules/libs/store_download.ts:1229`), `STORE_FLUSH_FLAG` (`modules/libs/store.ts:96`), and `WALK_COMMAND` (`walk_child.ts:32`). Only the first has a test that pins its spelling. `serve.test.ts:106-109` pins it against the registry.

## Goals / Non-Goals

**Goals:**

- A hung mount under one request leaves threads for each other file call of the server. This holds on the detached start, and on the foreground start on POSIX.
- The walk child keeps the default pool.
- One predicate names each self-started child, and the update gate uses it.

**Non-Goals:**

- No change to the widths of the staging, the list, or the read routes.
- No change to the pool of a command that a person runs.
- No Windows re-execution of the foreground server.

## Decisions

### D1. The pool size and its reader live in `src/lib/env.ts`

`env.ts` gets `fsPoolVar = "UV_THREADPOOL_SIZE"`, `serverFsPoolSize(cores)` = `Math.max(64, 4 * cores)`, `fsPoolSize()` (the value of the variable at call time, or `null`), and `serverChildEnv(base)`: `base` or `process.env`, plus `fsPoolVar` set to `String(serverFsPoolSize(cores))` when the base has no such variable. `cores` is `os.availableParallelism()`, or `os.cpus().length` where that function is absent. `walkChildEnv` removes `fsPoolVar` from its result, thus the walk child keeps the default pool even when the server has the large one. A value that the person set does not reach the walk child either: the walk measured about two times slower with a large pool, and the variable of the person targets the server, not the walk. This trade-off is accepted.

64 is the floor because the widths that one request holds are 16 (the staging walk, the list page) and a server handles some requests at one time. Each other child that the server starts inherits the variable: a transfer child, a flush child, and an `inflexa` command that the agent tool runs. A large pool costs them nothing measurable, because their work is network and disk writes, and none of them walks a tree at width 512. Only the walk child removes it. 4 times the cores keeps the floor meaningful on a large machine. The person wins: a value in the environment stays, as the spec says.

### D2. The detached child gets the environment at the spawn

`spawnDetachedServer` passes `env: serverChildEnv(undefined)` to `Bun.spawn`. The child then starts with the pool from its first file call. The spawn becomes a field of the serve options, with `Bun.spawn` as its production value, thus a test reads the `env` of the call.

### D3. The foreground server runs itself again before its first file call

A new module `src/lib/fs_pool_reexec.ts` exports `ensureServerFsPool(argv, execve, env)`: it calls `execve(process.execPath, selfInvocation(argv), serverChildEnv(env))` when four conditions hold. The command token is `serve`, `argv` holds neither `--detach` nor the detached flag, the platform is not `win32`, and the environment has no `fsPoolVar`. The command token is the first token that does not start with `-` and is not the value of the root options `--analysis` or `--project`. Thus `inflexa --analysis x serve` runs itself again too. The call never returns on success. `src/index.ts` imports this module first, before the extensions, and the module runs the check at its evaluation. Thus no module that opens a log stream or reads the update ran yet. The module imports only `env.ts` and `selfInvocation`. `selfInvocation` moves from `src/lib/cli.ts` to `src/lib/self_invocation.ts`, which imports `env.ts` only, and each importer changes to the new module. `lib/cli.ts` reaches `log.ts` through `shutdown.ts`, and the log stream must not open before the re-execution. `env.ts` imports no module of the project.

The `serve --detach` parent does not run itself again: it starts no server, and its child gets the environment from D2. The `serve --run-detached` child does not run itself again: the variable is in its environment already.

`process.execve` is a Bun API with no warning in Bun 1.4.2, as the probe shows. If a later Bun prints a warning, it goes to the terminal of the foreground server only, which is accepted.

On Windows `process.execve` throws, and an assignment to `process.env` is untested there, thus the foreground server keeps the default pool on Windows. The detached start, which is the path of each client, gives the pool on each platform. This is the accepted limit, named in the spec.

Alternative: the foreground server spawns itself as a child with the environment and proxies the signals. Rejected: a second process for the same terminal needs its own signal and exit handling. It costs more than a re-execution and gives the same result on POSIX.

### D4. The start line of the server log names the requested pool size

`runServe` logs `fsPoolSize()` in its start line as the requested pool size: the value of the variable, or `default` when it is absent. Bun clamps the value to 2 to 1024, thus the line names the request, not the measured size. The line is a log detail and not a contract: the spec names no requirement for it. A bench reads the pool of a running dev server from the log. A bench under `tmp/claude/` starts `bun src/index.ts serve` in the foreground with a temp data folder and reads the line.

### D5. One module names the self-started children

`src/lib/child_flags.ts` holds `SERVE_DETACHED_CHILD_FLAG`, `CLIENT_START_FLAG`, `IMAGE_TRANSFER_FLAG`, `CATALOG_TRANSFER_FLAG`, `STORE_FLUSH_FLAG`, `WALK_COMMAND`, and `isSelfStartedChild(args)`: true when `args` starts with `WALK_COMMAND`, or holds one of the flags. `CLIENT_START_FLAG` is a hidden option of `serve` that a client passes with `--detach` when it starts a server for an `instance` command. The argument vector cannot tell that start from a person's `serve --detach` otherwise, and the person would see the update notice twice: once from that child and once from the command. The four modules and the registry import the constants from there, each importer updated, no re-export. `walk_child.ts` keeps `isWalkChildInvocation` only if a second caller remains; otherwise it goes. `src/index.ts` gates the update read on `isSelfStartedChild(process.argv.slice(2))`.

The flag `--queued` of `store add` is not a self-start: the agent route passes it, thus it stays out of the predicate. `inflexa up`, which the TUI starts in the terminal of the person for the sign-in, is a command of the person with its own terminal, thus it stays out and keeps the update notice. The predicate names the hidden background children only.

Alternative: a list in `index.ts`. Rejected: the spelling would live in two places, and the spawn sites could drift from the gate.

### D6. The proof

- A unit test spawns a fixture script through `Bun.spawn` with `env: serverChildEnv(Bun.env)`. The script holds the larger of 16 and 2 times the core count of `open` calls on a FIFO, then reads a folder. That count is below the pool of the server on each machine, and at or above the default pool. The FIFO comes from `mkfifo` in the temp folder, POSIX only, with `test.skipIf` on Windows. The test asserts the answer, with a bound of 10 s on the child and a kill of the child at the end. A second run with the default pool asserts `BLOCKED`, to show that the test can fail. Its environment has neither `UV_THREADPOOL_SIZE` nor `GOMAXPROCS`, thus an inherited value cannot widen the control pool.
- A unit test of `ensureServerFsPool` with an injected `execve`: called with the variable for `["serve"]`, not called for `["serve", "--detach"]`, for `["serve", "--run-detached"]`, for `["ls"]`, and when the environment holds the variable.
- A unit test of `walkChildEnv`: the result holds no `fsPoolVar` when the base holds it.
- A unit test of `isSelfStartedChild` over each child argv and over `["ls"]`.
- A bench under `tmp/claude/bench/` runs the real foreground `serve` and reads the pool size from its start line. It also runs `pool.ts` with the environment of `serverChildEnv` against the default.

## Risks / Trade-offs

- [The re-execution doubles the start of the foreground server] → one `execve`, about 50 ms, only on the foreground path.
- [A later Bun prints a warning for `process.execve`] → the terminal of the foreground server shows one line, accepted.
- [The pool of the server holds up to 64 or more threads] → idle threads cost memory only, about 8 MB of stack address space each, not resident.
- [A person sets a small value] → the person wins, as the spec says.

## Open Questions

None.
