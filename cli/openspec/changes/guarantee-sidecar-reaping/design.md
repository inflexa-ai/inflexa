## Context

The reap guarantee must hold across three exit classes: orderly (normal exit, `shutdown()`), signaled (SIGTERM/SIGHUP — now routed through `shutdown()`), and unsurvivable (SIGKILL, CLI crash). In-process bookkeeping can cover the first two only; nothing running inside a `SIGKILL`ed process can cover the third.

## Decisions

### D1 — no supervision library; two in-repo layers

Surveyed options: npm `execa` (`cleanup: true`), `signal-exit`, `node-cleanup` — all are in-process exit/signal hooks, equivalent to what the CLI already wires, with the same blind spots (a pending continuation preempted by `process.exit`; `SIGKILL`). OS-native guarantees (`prctl(PR_SET_PDEATHSIG)` on Linux, Job Objects on Windows, kqueue `EVFILT_PROC` on macOS) are airtight but not exposed by `Bun.spawn` and would require native code per platform. A pipe-deadman shell wrapper (`sh -c 'server & cat; kill $!'` with the CLI holding the write end) survives every parent-death mode but inserts a wrapper process with its own signal-forwarding and portability problems (no `sh` on Windows).

Chosen: **(a)** close the in-process window with spawn-time tracking, **(b)** an orphan sweep keyed on the one signature that cannot lie — a process executing OUR materialized server binary whose parent is pid 1. Reparenting to init is what "orphaned" means at the OS level; a sidecar owned by any live CLI has that CLI as its parent and is never touched. The sweep runs at sidecar spawn (not CLI startup): a process that never embeds never scans anything, and the moment we add a sidecar is exactly the moment the graveyard matters.

### D2 — spawn-slot tracking

A module-level slot holds the current `SpawnHandle` from the moment `spawnLlamaServer` returns, cleared when the attempt fails (after its terminate) or promoted to `running` on success. `stopLocalSidecarAndWait` terminates `running ?? spawnSlot`. The reap hook is registered in `ensureReady` before `launchFor` is called (first invocation), so even the first launch's window is covered. The epoch discipline is unchanged — the slot is about reachability, the epoch about staleness.

### D3 — sweep mechanics

`ps -axo pid=,ppid=,command=` filtered to rows whose command starts with the materialized server binary path and whose ppid is 1 → SIGKILL (they are orphans; nothing coordinates a graceful stop). The binary path lives under inflexa's data dir, so the prefix match cannot capture foreign llama-servers. Injectable seam (`__setProcessScanForTest`) so tests drive the parser/decision without real processes. Windows: skipped with `TODO(extend)` — no ppid-1 reparenting signature there; the Windows sidecar target is cross-compiled and untested anyway.

### D4 — deterministic tail

`drainStderrTail` returns `{ tail(), settled: Promise<void> }`; the reader loop resolves `settled` in its `finally`. The early-exit failure branch awaits `settled` before reading — safe because the child's exit closes the pipe, which ends the reader loop promptly; no unbounded wait. The health-timeout branch reads the tail as before (30 s of drain time makes the race irrelevant, and the child may still be alive — awaiting `settled` there WOULD be unbounded).

### D5 — bounded readiness fetches

Each poll iteration's `fetch` gets `AbortSignal.any([exitSignal, AbortSignal.timeout(perRequestMs)])` (fall back to a manual combined controller if `AbortSignal.any` is unavailable in the pinned Bun). A timed-out request is treated like a refused connection — loop continues until the shared deadline. The advertised 30 s bound then holds even against a half-open server.

### D6 — second signal forces exit

First SIGTERM/SIGHUP: run `shutdown()` (unchanged). A second signal while shutdown is in flight: `process.exit(128 + signum)` immediately. Conventional CLI behavior; the escape hatch when a hook hangs. SIGINT stays untouched (chat-turn semantics).

### D7 — wipe ordering and orphan services

`wipe infra` runs `compose down` (best-effort: resolve a ready runtime without pinning; skip with a note when none) BEFORE deleting the compose file and Postgres data — mirroring `down --deleteData`'s stop-then-delete ordering. `composeUp` adds `--remove-orphans` so a service dropped by regeneration (mode switch) has its container removed by the engine instead of lingering.

## Risks / trade-offs

- The sweep sends SIGKILL to orphans (no graceful window) — acceptable: an orphan by definition has no owner doing work with it.
- `--remove-orphans` also removes containers from a hand-authored compose project sharing the same project name — not a real configuration (the file and project name are generated and owned by inflexa).
- D5's per-request timeout adds a tunable; it is a constant beside the poll interval, not config surface.
