## Why

Local-only CLI mode routes LLM chat through the user's own OAuth/API keys via CLIProxyAPI, but embeddings have no local option — they require an OpenAI API key pointed at a billing gateway. For a self-contained, offline-capable CLI, we need an in-process embedding model that downloads once and runs without a daemon or API key, while still offering the API-key path for users who prefer it.

## What Changes

- Add `node-llama-cpp` as an optional CLI dependency, lazy-loaded via dynamic `import()` only when the user opts into local embeddings at setup time (no native binaries fetched on a plain install).
- Add a CLI-side `EmbeddingProvider` realization (`createLocalEmbeddingProvider`) that loads `bge-small-en-v1.5` (GGUF, q8_0, 384-dim, 36 MB) in-process via node-llama-cpp, L2-normalizes every vector before returning it, and implements the harness `EmbeddingProvider.embed` seam.
- Add an embedding setup lifecycle (`inflexa setup --embeddings`) that downloads the GGUF model from HuggingFace on user opt-in, verifies it (load + embed probe + dimension check), and records the choice in config.
- Extend `config.json` with an `embedding` section: `{ mode: "local" | "api-key" | "off", modelPath?, apiKey? }`.
- Wire the embedding setup question into the interactive `inflexa setup` questionnaire, after provider auth.
- Add `env.modelDir` and `env.embeddingModelPath` to the CLI's path/env map.
- The provider is store-agnostic — it returns `number[][]` and is ready to inject into `assembleCoreRuntime` when the CLI wires the harness. No vector store is added in this change.

## Capabilities

### New Capabilities
- `local-embeddings`: In-process embedding model lifecycle — optional dependency management, GGUF model download/verify, config-driven mode resolution, and a CLI-side `EmbeddingProvider` realization that loads `bge-small-en-v1.5` via node-llama-cpp and L2-normalizes vectors.

### Modified Capabilities
<!-- No existing spec-level requirements change. The intelligence-module spec governs chat, not embeddings. The proxy setup command gains an embedding sub-question, but that is implementation, not a spec requirement change. -->

## Impact

- **New dependency**: `node-llama-cpp` (optional, lazy-loaded) — prebuilt llama.cpp binaries for macOS/Linux/Windows, fetched at setup-yes time via `bun pm trust`, not at install time.
- **New module**: `src/modules/embedding/` (vertical slice: local-provider, setup, resolve).
- **Modified files**: `lib/config.ts` (embedding config schema), `lib/env.ts` (model paths), `modules/proxy/setup.ts` (wire embedding question into the interactive questionnaire), `cli/index.ts` (help text).
- **No harness changes**: the `EmbeddingProvider` seam (`harness/src/providers/types.ts`) is already provider-agnostic; the CLI realization is injected at the CLI's composition root.
- **No vector store**: the provider returns `number[][]`; a store (sqlite-vec / local pgvector) is deferred to a future change when the CLI actually consumes embeddings.
- **Dimension**: `bge-small-en-v1.5` is 384-dim. The harness's per-analysis pgvector index (`search-config.ts:64`) hardcodes 1536 — a one-line parameterization is deferred with the store decision. The `regulatory-corpus` 1536 hardcode is cloud-only and untouched.
