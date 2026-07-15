## Why

An adversarial multi-agent review of the setup-ease work (runtime detect-and-pin, order-proof provisioning, llama-server sidecar embeddings) confirmed the core invariants hold but surfaced four clusters of debt:

1. **Spec drift.** The live `local-embeddings` spec still mandates the removed node-llama-cpp realization in three places (Purpose, client-side L2 normalization, a `getEmbeddingFor` concurrency cap that no longer exists), and `infra-state-resilience` shipped with a literal "TBD" Purpose. In a spec-driven repo the spec-of-record must not contradict the shipped code.
2. **Sidecar lifecycle robustness.** A sidecar that crashes after a successful launch is never respawned (cached readiness is never invalidated); a child that dies at spawn burns the full 30s health timeout — twice with the retry — because process exit is never observed; `stderr: "pipe"` is never drained (latent pipe-backpressure wedge, and the promised "post-mortem" diagnostics don't exist); the minted API key rides argv (visible in `ps`); the NO_PROXY bypass mutates the two spellings independently and can shadow a user's single-spelling corp bypass; a signal-terminated CLI never runs the reap; a stop racing an in-flight launch can leak the process.
3. **Provisioning edges.** `inflexa up` guards mount sources for the config-derived mode while `compose up` executes whatever compose file is on disk — a stale file resurrects the engine-manufactured-directory incident transiently; the provider-login `docker run -v` bind-mounts the same file-typed path without passing through the guard seam; the `path_occupied` message claims "It is not empty" for occupants (symlink, socket) where that is meaningless.
4. **Small correctness/UX debts.** A pin bump with a warm `.llama-cache` can embed a superseded runtime archive (build never sweeps stale cache entries, and the embed specifiers are independent literals); a typo'd `runtime` config value is silently discarded and auto-pin may then choose the opposite engine with no mention; the hard-gate error never names `inflexa setup` as the sanctioned way to switch runtimes; `wipe all` cannot reset the compose file or Postgres data; two comments document the deleted node-llama-cpp world; several spec-mandated behaviors (pin-write-failure abort, status-no-pin) have no regression tests.

## What Changes

- **local-embeddings spec corrected and extended.** Purpose rewritten for the sidecar realization; the normalization requirement restated as an outcome (unit vectors) with the server-side realization named; the concurrency-cap requirement removed. New lifecycle requirements: crash-after-ready invalidates cached readiness so the next embed respawns; launch observes child exit and fails fast instead of waiting out the health timeout; stderr is drained into a bounded tail that launch failures include; the API key travels in the child's environment (`LLAMA_API_KEY`), never argv; termination escalates SIGTERM→SIGKILL and covers signal-terminated CLI exits; a stop racing an in-flight launch still reaps; the proxy bypass unions both `NO_PROXY` spellings.
- **infra-state-resilience tightened.** Every compose entry point regenerates the compose file from current config before the guard runs (write-if-missing is removed), so guard and executed file cannot drift; one-off container invocations that bind-mount file-typed paths route through the same provisioning seam; occupant diagnostics name the actual occupant kind; Purpose filled in.
- **container-runtime messaging.** A discarded unrecognized `runtime` value is named when the key is next pinned; the hard-gate error names `inflexa setup` as the switch path.
- **Build integrity.** The build sweeps `.llama-cache` entries that match no current pin, so a stale embed specifier fails the build loudly instead of embedding a superseded runtime.
- **Dev tooling.** `wipe` gains an `infra` target (compose file + Postgres data dir), included in `all`.
- **Comment corrections.** `install_context.ts`'s rationale rewritten around asset-source routing (its actual role); a changelog-phrased test comment reworded.
- **Tests.** Regression coverage for: pin-write-failure abort, sandbox-status-no-pin, launch early-exit fast-fail, crash invalidation and respawn, stop/launch race, negative proxy-bypass (bypass removed → embed fails), concurrent-coalescing, single-spelling NO_PROXY union, symlink occupant classification.

**Deferred (recorded, not implemented here):**
- Podman sandbox backend — the harness `SandboxBackendConfig` supports only `"docker" | "k8s"`; per the monorepo boundary rule this is a harness-first capability. A `TODO(extend)` marks the composition-root hard-code.
- Token-aware input truncation — the char-budget guard is correct for the English-tuned model; a `TODO(robustness)` records the CJK/emoji gap.

## Capabilities

- `local-embeddings` (modified)
- `infra-state-resilience` (modified)
- `container-runtime` (modified)

## Impact

- `src/modules/embedding/local-provider.ts` (+test): stderr tail, env key, exit racing, crash invalidation, launch epoch, kill escalation, NO_PROXY union.
- `src/index.ts` / `src/lib/shutdown.ts`: SIGTERM/SIGHUP run the shutdown chain.
- `src/modules/infra/{compose,lifecycle,postgres,setup,proxy_config}.ts` (+tests): compose regeneration at every entry point (`ensureComposeFile` deleted), guarded login-container mounts, occupant-kind messages.
- `src/lib/config.ts` (+test): discarded-value notice, hard-gate setup hint.
- `scripts/build.ts`: cache sweep. `scripts/wipe.ts`: infra target.
- `src/lib/install_context.ts`, `src/modules/infra/setup.test.ts`: comment corrections.
- `src/modules/harness/runtime.ts`: TODO(extend) marker only.
- Live spec Purposes (`local-embeddings`, `infra-state-resilience`): direct edits (deltas carry requirements; Purpose updates are the post-archive mechanism OpenSpec itself points at).
