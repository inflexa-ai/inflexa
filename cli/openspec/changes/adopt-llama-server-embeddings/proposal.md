## Why

Local embeddings — the flagship "no API key, runs on your machine" mode — only work from a source checkout today: the native runtime (`node-llama-cpp`) is `external` to the compiled single-file binary and can never resolve inside it, so the packaged product currently *declines* the mode instead of delivering it. Research proved a strictly better realization end-to-end: a pinned official `llama.cpp` `llama-server` sidecar serves OpenAI-compatible `/v1/embeddings` for our exact bge-small GGUF (CLS pooling auto-read from the model, L2-normalized 384-dim, 0.16 s warm start, 86 MB RSS, loopback + API-key enforced, clean SIGTERM), and Bun compiled binaries can carry the per-target runtime archive as an embedded asset with byte-exact extraction and zero startup cost. Local embeddings should simply work — compiled or from source, same stack.

## What Changes

- Replace `node-llama-cpp` entirely with a `llama-server` sidecar: the in-process provider, the `bun pm trust` step, and the `optionalDependencies`/`trustedDependencies` entries are all removed. One embedding stack serves both the compiled binary and source checkouts — dev runs exercise exactly what ships.
- Ship the runtime "B-lite": each compiled target embeds its pinned llama.cpp release archive (~10 MB) as a build-time asset, materialized into the data dir on first use (hash-verified, atomic); source checkouts download the same pinned, SHA-256-vendored artifact into the same layout at setup. The model GGUF keeps its existing HuggingFace download.
- Local mode becomes available in the compiled binary again: the interactive picker offers it everywhere, `--embeddings local` works, and the compiled-context refusals from the previous iteration (`local_unavailable` fail-fast, picker omission, trust-step scoping) are removed. The install-context accessor remains, now selecting the runtime *source* (embedded asset vs download) rather than gating the feature.
- The local provider becomes: ensure runtime materialized → spawn `llama-server` on a free loopback port with a minted API key → poll readiness → embed through the **existing** harness OpenAI-shaped embedding provider (`dimensions: 384`) → terminate on shutdown. Inputs are chunk/truncate-guarded against the model's 512-token ceiling.
- Setup's model verification (load + probe + dimension assert) runs through the sidecar instead of an in-process import — identical behavior compiled and from source.

## Capabilities

### New Capabilities

*(none — the sidecar is the new realization of the existing local-embeddings capability)*

### Modified Capabilities

- `local-embeddings`: the provider realization, native-runtime acquisition, setup/verification flow, and install-context behavior are re-specified around the sidecar; the node-llama-cpp-specific requirements (optional dependency, `bun pm trust`, compiled-context unavailability) are removed or rewritten.

## Impact

- `src/modules/embedding/` — `local-provider.ts` rewritten around the sidecar lifecycle + the existing harness `createEmbeddingProvider`; `setup.ts` drops the trust step and compiled-context refusals, gains runtime materialization; `resolve.ts` local branch wires the sidecar-backed provider.
- New runtime-acquisition module (embedded-asset extraction + pinned download, shared materialization/verification) with vendored per-platform SHA-256s and the pinned tag as named constants (macOS arm64 pinned to a macOS 14/15-compatible build — current upstream macOS builds require macOS 26).
- `scripts/build.ts` — per-target embedded runtime asset via define-gated dynamic import; build fetches pinned archives (cached, hash-checked).
- `package.json` — `node-llama-cpp` removed from `optionalDependencies` and `trustedDependencies`.
- Tests: sidecar lifecycle against a stub server; materialization matrix (embedded vs downloaded, hash mismatch, partial extraction); integration test gated on runtime presence.
- No new npm dependencies. The binary grows ~10 MB per target; the 36 MB model download at setup is unchanged.
