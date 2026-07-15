# Tasks

## 1. Sidecar reachability + diagnostics (`src/modules/embedding/local-provider.ts` + test)

- [x] 1.1 Spawn-slot tracking: module-level slot set the moment `spawnLlamaServer` returns, cleared on attempt failure (after terminate) or promotion to `running`; `stopLocalSidecarAndWait` terminates `running ?? slot` (D2)
- [x] 1.2 Register the reap hook in `ensureReady` BEFORE `launchFor` runs, so the first launch's window is covered (D2)
- [x] 1.3 Orphan sweep at spawn: kill processes executing the materialized server binary with ppid 1; injectable process-scan seam; Windows skipped with `TODO(extend)` (D3)
- [x] 1.4 `drainStderrTail` exposes `settled`; the early-exit failure branch awaits it before reading the tail; the timeout branch reads as before (D4)
- [x] 1.5 Per-request timeout on readiness fetches combined with the exit abort; timed-out request treated like a refused connection (D5)
- [x] 1.6 `terminateProcess` idempotency latch (one SIGTERM, one escalation timer, same settled promise) (D6-adjacent)
- [x] 1.7 Tests: shutdown-during-launch reaps the in-flight child (spawn seam records terminate); watcher ABA guard (launch → stop → relaunch → late crash of sidecar 1 must not clobber sidecar 2's cache — fails if the epoch check is removed); sweep decision table (orphan killed, live-parented spared, foreign binary spared); tail completeness on early exit through the REAL drain (stub process with piped stderr that writes then exits); half-open server fails at the deadline

## 2. Signals + hygiene (`src/index.ts`, `src/lib/config.ts`)

- [x] 2.1 Second SIGTERM/SIGHUP while shutdown is in flight → immediate `process.exit(128 + signum)`; first-signal behavior unchanged; SIGINT untouched (D6)
- [x] 2.2 Justification comments on the two `as` casts in `discardedRuntimeValue` (config.ts:182,186)

## 3. Infra edges (`src/modules/infra/compose.ts` + tests, `scripts/wipe.ts`)

- [x] 3.1 `composeUp` adds `--remove-orphans` so a mode switch reaps the dropped service's container (D7)
- [x] 3.2 `wipe infra` stops the stack (best-effort compose down: ready runtime resolved without pinning; skipped with a note when none) before deleting the compose file and Postgres data (D7)
- [x] 3.3 Entry-point regeneration wiring test: `up`/`ensurePostgresReady` call `writeComposeFile` before `composeUp` (injectable or spy-based, so a future write-if-missing reintroduction fails)

## 4. Verification (orchestrator)

- [x] 4.1 Typecheck, lint, full suite green; `openspec validate` all specs + change
- [x] 4.2 Live smoke: SIGTERM during a cold launch reaps the child; manufactured ppid-1 orphan swept at next embed; existing crash-respawn/reap smoke still passes
