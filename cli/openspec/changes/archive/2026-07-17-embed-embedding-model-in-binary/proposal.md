## Why

A client running behind a corporate proxy cannot reach huggingface.co, so `inflexa setup --embeddings local` fails at the model download — even though the compiled binary already carries the llama-server *runtime* as an embedded asset and needs no network for it. The bge-small GGUF (~36 MB) is the last network dependency of local-embeddings setup in the compiled binary; embedding it closes the gap and makes local-embeddings setup fully offline for release binaries.

## What Changes

- `scripts/build.ts` downloads the pinned `bge-small-en-v1.5-q8_0.gguf` into the existing `.llama-cache/` at build time, verifies it against the vendored `MODEL_SHA256` pin (the same integrity authority setup uses at runtime), and embeds it into **every** target binary via the same define-gated `import(..., { with: { type: "file" } })` mechanism the llama runtime uses. The model is platform-independent, so unlike the per-target runtime archives there is one asset and no per-target DCE selection.
- The build's stale-cache sweep keeps the model artifact in its keep-set so it is not removed as "matching no current pin".
- Model acquisition in `src/modules/embedding/setup.ts` becomes source-aware, mirroring `llama_runtime.ts`: a compiled binary copies the embedded asset to `env.embeddingModelPath` (bunfs-safe byte read, no network); a source checkout downloads from HuggingFace as today. Both paths verify the SHA-256 before the file lands at the final path.
- Net effect: `inflexa setup --embeddings local` in a compiled binary completes with zero network access. From-source behavior is unchanged.
- When `inflexa setup` is invoked with an explicit `--embeddings local|api-key|off` preselection, the embedding step runs BEFORE the container-runtime probe (`firstReadyRuntime`), so egress-restricted/air-gapped users with no ready Docker/Podman can still configure embeddings non-interactively — the exact audience this change serves now that the model is a build-time embedded asset. A missing runtime still fails the rest of setup afterward (exit 1); the interactive no-preselection flow keeps the embedding question in its spec'd position (after provider auth); the step runs at most once per invocation.
- Release binaries grow by ~36 MB per target. No config, CLI-surface, or hot-path changes.

## Capabilities

### New Capabilities

_None — this hardens an existing capability._

### Modified Capabilities

- `local-embeddings`: the "Embedding setup downloads and verifies the model on opt-in" requirement becomes source-aware — the compiled binary acquires the model from a build-time embedded asset with no network, a source checkout downloads the pinned file; a new requirement covers build-time model embedding (pinned, hash-verified at build, embedded for every target, protected from the stale-cache sweep); and the "Embedding setup is wired into the interactive setup flow" requirement gains a preselected-before-gate path — an explicit `--embeddings` selection runs the embedding step before the container-runtime probe (so a runtime-less host can still configure embeddings non-interactively), while the interactive question keeps its position after provider auth and the step never runs twice in one invocation.

_(The container-runtime "Setup falls back to any ready runtime" requirement is unchanged: setup still fails when no supported runtime is ready, and the runtime is still pinned before any container work. The reorder only moves a non-container step ahead of the probe, which that requirement does not constrain.)_

## Impact

- `cli/scripts/build.ts` — model cache/verify/embed step beside `ensureLlamaArchiveCached`; sweep keep-set.
- `cli/src/modules/embedding/setup.ts` — `downloadModel()` grows an embedded-asset branch routed by `isCompiledBinary()`; user-facing copy that says "downloads … from HuggingFace" adjusted where it would now be wrong in the compiled context.
- Release workflow: unchanged (build already fetches pinned artifacts from the network on `ubuntu-latest`); one extra ~36 MB fetch per release build, cached in `.llama-cache/`.
- Not chosen: committing the model via Git LFS — `actions/checkout` would skip the blob by default, but LFS bandwidth is billed to the repo owner (~28 downloads/month on the free tier at this size), contributors would need `git-lfs`, and it would add a second artifact-distribution mechanism beside the established build-time one.
