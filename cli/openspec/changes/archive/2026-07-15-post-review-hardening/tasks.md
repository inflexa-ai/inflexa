# Tasks

## 1. Sidecar lifecycle (`src/modules/embedding/local-provider.ts` + test)

- [x] 1.1 Drain stderr into a bounded tail (~8 KB ring) started at spawn; expose the tail on the spawn handle; append it to launch/health failure messages (D1)
- [x] 1.2 Deliver the minted API key via the child's env (`LLAMA_API_KEY`), dropping `--api-key` from argv (D4)
- [x] 1.3 Keep `proc.exited` on the spawn handle; race it against `pollLlamaHealth` in `defaultLaunch` so an early exit fails the attempt immediately (retry semantics unchanged) (D5)
- [x] 1.4 Post-ready exit watcher: when the current sidecar exits, clear cached `ready`/`running` so the next `embed()` respawns; failed-launch caching unchanged (D5)
- [x] 1.5 Launch epoch: `stopLocalSidecar` during an in-flight launch causes the resolving launch to reap its own process and cache nothing (D5)
- [x] 1.6 `stop()` escalates SIGTERM→SIGKILL after a 2 s grace via `proc.exited`; the shutdown hook awaits the escalation (D6)
- [x] 1.7 `ensureLoopbackProxyBypass` computes the union across both `NO_PROXY` spellings and writes it to both (D8)
- [x] 1.8 `TODO(robustness)` on the char-budget guard documenting the CJK/emoji token-overflow gap (D11)
- [x] 1.9 Tests: early-exit fast-fail (stub child that exits; assert sub-timeout failure + tail in message), crash-after-ready invalidation + respawn, stop-during-launch reap, concurrent first-embeds coalesce (Promise.all, one launch), single-spelling NO_PROXY union, negative proxy-bypass (bypass suppressed → embed against stub fails)

## 2. Signal-covered shutdown (`src/index.ts`, `src/lib/shutdown.ts`)

- [x] 2.1 Install SIGTERM/SIGHUP handlers that run the `shutdown()` chain once and exit `128 + signal`; SIGINT untouched (chat-turn semantics live in `harness/chat.ts`) (D3)

## 3. Provisioning coherence (`src/modules/infra/*` + tests, `scripts/wipe.ts`)

- [x] 3.1 `up` and `ensurePostgresReady` regenerate the compose file via `writeComposeFile`; delete `ensureComposeFile`; update the `compose.ts` design comment that described the write-if-missing split (D2)
- [x] 3.2 Provider-login container provisions its file-typed mount through the shared seam before `docker run` (structural, not caller courtesy)
- [x] 3.3 `classifyPath`'s occupied result carries the occupant kind (non-empty directory | symlink | other); `formatInfraStateError` renders kind-specific prose (D10)
- [x] 3.4 Tests: symlink occupant classifies `path_occupied`, is not followed, nothing deleted; compose regeneration on mode drift (file regenerated for current mode before guard)
- [x] 3.5 `wipe` gains an `infra` target (`env.composeFilePath`, `env.postgresDataDir`), included in `all`

## 4. Runtime selection UX (`src/lib/config.ts` + tests, new `src/modules/libs/pull.test.ts`)

- [x] 4.1 Pin notice names a discarded unrecognized `runtime` value (raw-config peek in the pin path only) (D9)
- [x] 4.2 Hard-gate failure appends the `inflexa setup` switch hint
- [x] 4.3 Tests: pin-write-failure aborts (fs-induced write failure; no unpinned proceed), discarded-value notice, `sandboxStatus` never writes config (no-pin regression)

## 5. Build + comments + specs

- [x] 5.1 `build.ts` sweeps `.llama-cache/` entries matching no `LLAMA_PINS` artifact before compiling (D7)
- [x] 5.2 Rewrite `install_context.ts`'s header/JSDoc around its actual role (asset-source routing between embedded asset and pinned download), dropping the node-llama-cpp rationale
- [x] 5.3 Reword the changelog-phrased comment at the top of `src/modules/infra/setup.test.ts` (state where the tests live, not that they moved)
- [x] 5.4 Fill in the live spec Purposes: `local-embeddings` (sidecar realization) and `infra-state-resilience` (replace the TBD)
- [x] 5.5 `TODO(extend)` at the `backend: "docker"` line in `src/modules/harness/runtime.ts` recording the harness-first podman-sandbox gap (D11)

## 6. Verification (orchestrator)

- [x] 6.1 `bun run typecheck`, `bun run lint`, full `bun test src` green from `cli/`
- [x] 6.2 `openspec validate` passes for all specs; archived-change hygiene intact
- [x] 6.3 Live smoke: spawn sidecar via a local embed, `kill -9` the sidecar, next embed respawns; `kill -TERM` the CLI, sidecar reaped; host build (`bun run build` single target) succeeds after cache sweep
