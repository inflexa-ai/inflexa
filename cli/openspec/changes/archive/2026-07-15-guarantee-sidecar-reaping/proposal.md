## Why

Round-2 adversarial review of the hardening sweep confirmed one major and a set of smaller defects. The major: the sidecar reap can still miss. `running` is assigned — and the shutdown reap hook registered — only in the launch **success** continuation, so during the launch window (child spawned, readiness pending, seconds on a cold start) a `shutdown()` from SIGTERM/SIGHUP/`beforeExit` finds nothing to stop, and `process.exit()` preempts the epoch self-reap continuation. The child survives (empirically confirmed: a `process.exit` mid-launch orphaned a live llama-server). In-process hooks — ours or any library's (`execa cleanup`, `signal-exit`) — can never cover `SIGKILL` of the CLI either, so orphan-healing needs a second layer that does not depend on the dying process.

Also confirmed: the stderr tail can be empty on the exact early-exit path whose spec scenario promises diagnostics (the tail is read synchronously when the exit race resolves; the drain loop may not have consumed the final chunks); the readiness deadline is defeated by a half-open server that accepts but never answers (no per-request timeout); the watcher's ABA epoch guard is untested (deleting it leaves the suite green); `wipe infra` deletes the compose file and Postgres data without stopping containers (and `inflexa down` then cannot run — it needs the deleted file); a mode switch leaves the dropped proxy service's container orphaned (`compose up -d` without `--remove-orphans`, now reachable from `up`); a second SIGTERM cannot force exit if a shutdown hook hangs; `terminateProcess` double-call arms two SIGKILL timers; two `as` casts lack their mandated justification comments; the mode-drift tests pin `writeComposeFile`'s contract but not the entry-point wiring.

## What Changes

- **Spawn-time reap coverage (the major).** The live child is tracked from the moment `Bun.spawn` returns; the shutdown reap hook is registered before the first launch begins; `stopLocalSidecarAndWait` terminates the ready sidecar or the in-flight spawn, whichever exists. No launch state leaves a child unreachable.
- **Orphan sweep at spawn.** Before spawning, processes executing our materialized `llama-server` binary that have been reparented to pid 1 are killed — the definitive orphan signature, so a concurrent CLI's sidecar (parented to that live CLI) is never touched. Heals `SIGKILL`/crash leftovers at the next embed. Not run on passive flows (no embed → no sweep), per the no-litter stance.
- **Deterministic stderr tail.** The drain exposes its completion; the early-exit failure path awaits it (the child's exit closes the pipe, so completion is prompt and bounded) before reading the tail — the spec's "failure includes the tail" holds always, not raced.
- **Bounded readiness fetches.** Each health/props request carries its own timeout combined with the child-exit abort, so a half-open server cannot hang the launch past the advertised deadline.
- **Second signal forces exit.** A repeated SIGTERM/SIGHUP bypasses the in-flight shutdown and exits immediately with the signal code — the conventional escape hatch when a hook hangs.
- **`terminateProcess` idempotency latch** (single SIGTERM + single escalation timer regardless of call count).
- **`wipe infra` stops the stack first** (compose down before deleting the compose file and Postgres data, tolerating a missing runtime), and `compose up -d` gains `--remove-orphans` so a mode switch reaps the dropped service's container.
- **Tests:** watcher ABA guard (launch → stop → relaunch → late crash of the first sidecar must not clobber the replacement's cache), entry-point regeneration wiring, sweep unit coverage (seam-injected process lister/killer), second-signal behavior where feasible.
- **Comment hygiene:** justification comments on the two `discardedRuntimeValue` casts.

## Capabilities

- `local-embeddings` (modified)

The wipe/compose/index/config items are code-quality fixes below spec granularity; `--remove-orphans` keeps the existing mount/provisioning contracts intact.

## Impact

- `src/modules/embedding/local-provider.ts` (+test): spawn-slot tracking, sweep, tail await, fetch timeouts, latch.
- `src/index.ts`: second-signal force exit. `src/lib/config.ts`: cast comments.
- `src/modules/infra/compose.ts` (+tests): `--remove-orphans`; entry-point wiring test.
- `scripts/wipe.ts`: stop-then-delete for the infra target.
