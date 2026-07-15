## Context

Every item here was confirmed against the code (file:line-verified) by the review; this design records the chosen fixes and the alternatives that were rejected. Three choices were put to the user explicitly; their decisions are D1–D3.

## Decisions

### D1 — stderr: drain to a bounded tail (user decision)

`stderr: "pipe"` stays, but a per-spawn async reader continuously drains the stream into a small ring buffer (last ~8 KB). Rationale: `stderr: "ignore"` would fix the backpressure wedge in one word but throws away the only diagnostic channel — with the tail, a launch failure (early exit, health timeout) can include llama-server's actual complaint ("failed to load model", bind errors) instead of a generic timeout line. The drain must start immediately at spawn (before health polling) so the pipe can never fill regardless of how the launch proceeds. The tail is exposed on the spawn handle; `defaultLaunch` appends it to the `providerFault` message when an attempt fails.

### D2 — compose-file/guard coherence: regenerate at every entry point (user decision)

`inflexa up` and `ensurePostgresReady` switch from `ensureComposeFile` (write-if-missing) to `writeComposeFile` (always regenerate), and `ensureComposeFile` is deleted. Now all four compose entry points (setup, TUI launch gate, `up`, postgres gate) derive the executed file and the mount-source guard from the same current-config facts in the same call — the drift class is gone at the root, not patched at the guard. Rejected alternative: parsing the on-disk file's bind mounts and guarding those (guard-follows-file) — it preserves hand-edited compose files across `up`, but that support was already illusory (the TUI launch gate regenerates on every launch), and it keeps two coexisting semantics plus a YAML-parsing guard alive for a file we generate ourselves.

### D3 — signal coverage: SIGTERM/SIGHUP run the shutdown chain (user decision)

`src/index.ts` installs `SIGTERM` and `SIGHUP` handlers that run the same `shutdown()` hook chain as normal exit (telemetry flush, DB close, sidecar reap), then exit with the conventional `128 + signal` code. Reentrancy: `shutdown()` already guards double-entry; the handlers must not fight the turn-scoped SIGINT handling in `harness/chat.ts` (SIGINT is deliberately NOT touched here — it has chat-turn semantics). This is a CLI-wide behavior change accepted for its standard-practice payoff: `kill <pid>` or a closed terminal never orphans the sidecar or skips flushes.

### D4 — API key via `LLAMA_API_KEY` env

The pinned b9310 binary's `--api-key` documents the env equivalent `LLAMA_API_KEY` (verified against the actual cached binary's `--help`). The key moves off argv into `Bun.spawn`'s `env` for the child only — invisible to `ps`, no key file to manage, no ambient-env leak (the variable is set on the child's env object, not on `process.env`).

### D5 — crash recovery: exit watcher + launch epoch

The spawn handle keeps `proc.exited`. Two consumers:

- **Fast launch failure**: `defaultLaunch` races `proc.exited` against `pollLlamaHealth`; a child that exits during startup fails that attempt immediately (with the stderr tail) instead of waiting out the 30 s timeout. The existing fresh-port retry semantics are unchanged — an early exit consumes an attempt exactly like a health timeout did.
- **Post-ready invalidation**: once a launch succeeds, `proc.exited` continuation clears the module's cached `ready`/`running` — but only if that handle is still the current one (a stale watcher from a superseded sidecar must not clobber its replacement). The next `embed()` then respawns. A *failed* launch stays cached for the process lifetime, unchanged — that is a deliberate existing property (the readiness timeout is paid at most once), and the failure modes it covers (runtime missing, model broken) are not transient.

A monotonically increasing launch epoch, captured when a launch starts and compared in `stopLocalSidecar` and in the launch continuation, closes the stop-during-launch race: a launch that resolves after its epoch was invalidated immediately stops its own process and caches nothing.

### D6 — kill escalation

`stop()` sends SIGTERM, then SIGKILLs if `proc.exited` has not settled within a 2 s grace. The measured clean exit is <10 ms, so the escalation is a pure backstop for a wedged server; the grace is not user-visible on the healthy path. `stopLocalSidecar` stays synchronous fire-and-forget for its existing callers; the shutdown hook awaits the escalation so `shutdown()` cannot resolve while the child is undead.

### D7 — build cache sweep

Before compiling any target, `scripts/build.ts` removes every file in `.llama-cache/` whose name matches no `LLAMA_PINS` artifact. Consequence: after a pin bump, a forgotten embed-import literal cannot silently resolve against the superseded archive — the stale file is gone, the dynamic `import(...)` fails to resolve, and the build dies loudly (the same failure a clean CI checkout would produce). Rejected alternative: asserting the five literals against `LLAMA_PINS` by grepping the module source from the build script — brittle string-matching over source text, and the sweep achieves the same guarantee through the artifact itself.

### D8 — NO_PROXY union across spellings

The bypass computes the union of entries from `NO_PROXY` and `no_proxy`, adds the loopback hosts, and writes the same union back to both spellings. A user who set only `no_proxy=corp.example.com` ends with both spellings carrying `corp.example.com,127.0.0.1,localhost` — whichever spelling Bun's fetch prefers, no previously honored entry is shadowed. Assignment-only (never delete) stays, per the documented Bun 1.3.14 propagation quirk.

### D9 — discarded runtime value is named

`z.enum(...).catch(undefined)` stays (corrupt config must never block startup — spec-mandated). The notice gains the context: when `ensureRuntime` pins on an unset selection, it re-reads the raw config file and, if a string `runtime` value was discarded by validation, the pin message names it ("Ignoring unrecognized runtime \"podmna\" in config.json — using Podman…"). The raw peek lives in the pin path only, so passive reads pay nothing.

### D10 — occupant-kind-aware diagnostics

`classifyPath`'s `"occupied"` result carries what was found (`non-empty directory` | `symlink` | `other`), and `formatInfraStateError` renders kind-specific prose — the "It is not empty" sentence only for the non-empty-directory case. Remediation (move or remove, then re-run) is shared.

### D11 — deferred items

- **Podman sandboxes**: harness `SandboxBackendConfig.backend` is `"docker" | "k8s"` (read from the installed package's types). The monorepo boundary rule says capabilities are designed harness-first; the CLI records `TODO(extend)` at the `backend: "docker"` composition-root line and changes nothing.
- **Token-aware truncation**: `MAX_INPUT_CHARS` assumes ~3.1 chars/token, which under-counts CJK/emoji; a `TODO(robustness)` documents that a pathological non-Latin input can still exceed the 512-token ceiling and 500 at request level (per-request failure, not a wedge).

## Risks / trade-offs

- D2 removes any residual support for hand-edited compose files; accepted — the file is a generated artifact and was already regenerated on every TUI launch.
- D3 changes behavior for every `kill`-terminated CLI invocation (hooks now run). The hooks are all idempotent-by-contract; the risk is a hook that hangs delaying signal exit — mitigated by the existing `shutdown()` settle semantics and the D6 grace bound.
- D5's watcher makes `ready` mutable from an async continuation; the epoch comparison is the only guard against ABA-style staleness, so both writers (watcher, `stopLocalSidecar`) must go through it.
