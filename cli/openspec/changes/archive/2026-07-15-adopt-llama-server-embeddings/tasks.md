## 1. Pin and acquisition seam

- [x] 1.1 Vendor the runtime pin in one constants module: exact llama.cpp release tag per platform (macOS arm64 pinned to a macOS 14/15-compatible build — verify the chosen tag's `minos` before vendoring), artifact names, and SHA-256 checksums computed from the actual downloaded archives; document the pin-bump procedure and the macOS-floor rationale inline.
- [x] 1.2 Implement the materialization seam (new embedding runtime module): verify SHA-256 → extract the full archive dir (system `tar`; bunfs-safe reads via `Bun.write`/`readFileSync` only) → atomic rename to the tag-named directory under the data dir; idempotent re-runs; partial failures leave nothing at the final path; typed `Result` errors with remediation.
- [x] 1.3 Source-aware byte acquisition: compiled binary reads its embedded asset (define-gated per-target dynamic import so each target embeds exactly one archive); source checkout downloads the pinned artifact with progress; both feed the same materialization step; `install_context.ts` routes the source and stops gating the feature.
- [x] 1.4 `scripts/build.ts`: fetch the pinned per-target archives at build time (hash-checked, cached outside git), and embed each target's archive via the per-target define mechanism; missing/failed fetch fails the build loudly.

## 2. Sidecar lifecycle + provider

- [x] 2.1 Sidecar lifecycle in the embedding module: lazy spawn of `llama-server -m <gguf> --embeddings --host 127.0.0.1 --port <free> --api-key <minted>`, authenticated health polling with a first-run-scan-tolerant timeout, per-process reuse, SIGTERM reap wired into the existing shutdown path, and no-orphan arrangement for abnormal parent death.
- [x] 2.2 Rewrite `local-provider.ts` around the sidecar: `createLocalEmbeddingProvider({ modelPath })` ensures materialization + lifecycle, then delegates to the harness `createEmbeddingProvider` with the loopback `baseURL`, minted key, and `dimensions: 384`; all failures on the `Result` channel with actionable remediation; delete the node-llama-cpp import path and `COMPILED_LOCAL_UNAVAILABLE_REASON`.
- [x] 2.3 Client-side 512-token ceiling guard: verify what chunk sizes the harness actually sends today, then truncate or chunk over-length inputs in the provider so the server never 500s on length.

## 3. Setup + gates + dependency removal

- [x] 3.1 `embedding/setup.ts`: delete `trustNativeRuntime` and every compiled-context refusal (`local_unavailable` fail-fast, picker omission); the picker offers `local`/`api-key`/`off` in every install context; `runLocalSetup` = materialize runtime + download model (existing) + verify through the sidecar (spawn, probe-embed, assert 384, shut down).
- [x] 3.2 `ensureEmbedderReady`: model-file + runtime-materialized(-able) existence checks only (no spawn, no probe); missing model directs to `inflexa setup --embeddings local` in every context; drop the compiled-context switch-modes error.
- [x] 3.3 Remove `node-llama-cpp` from `package.json` (`optionalDependencies`, `trustedDependencies`), refresh the lockfile, and verify no import of it remains anywhere in `src/`.
- [x] 3.4 `resolve.ts`: confirm the local branch wires the sidecar-backed provider unchanged from the caller's perspective (same `EmbeddingProvider` seam, same config shape).
- [x] 3.5 `ensureEmbedderReady` self-heals the runtime: when the model is present but the runtime directory is absent, the gate materializes it (embedded asset or pinned download) and only then returns ok — an offline source checkout fails at launch with remediation, never mid-chat; a materialized runtime short-circuits with zero acquisition work.

## 4. Tests

- [x] 4.1 Materialization matrix: hash mismatch fatal+clean, partial extraction leaves nothing at the final path, idempotent re-run, embedded-vs-downloaded source selection (compiled context simulated via the existing test override).
- [x] 4.2 Lifecycle against a stub HTTP server (no real llama-server): lazy spawn on first embed, reuse across embeds, authenticated readiness (401 rejected), SIGTERM reap on shutdown, over-length input guarded.
- [x] 4.3 Provider seam: `embed()` returns `ResultAsync` vectors from the stubbed endpoint; sidecar-failure paths yield `err(ProviderError)` with remediation, never a throw.
- [x] 4.4 Real-sidecar integration test gated on the materialized runtime being present (skip otherwise, like the existing GGUF-gated tests): spawn, probe-embed the real model, assert 384-dim and L2 normalization.
- [x] 4.5 Prune tests that pinned the removed behaviors (compiled-context refusals, trust step, node-llama-cpp import failures) and keep the from-source suites green.

## 5. Verification

- [x] 5.1 `bun run typecheck` (zero errors), lint, `bun run format:file` on touched src files, full `bun test src` inside `cli/`.
- [x] 5.2 `openspec validate adopt-llama-server-embeddings`; live checks: (a) from source, `inflexa setup --embeddings local` end-to-end (materialize, download, sidecar-verify) then a real embed; (b) build the host binary and run the same setup + embed against the baked runtime; (c) confirm no sidecar process survives CLI exit.
