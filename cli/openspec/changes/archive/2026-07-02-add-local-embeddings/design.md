## Context

The CLI's local-only mode routes LLM chat through CLIProxyAPI (OAuth/device-flow for Gemini/OpenAI/Claude/Qwen/iFlow), but embeddings have no local path — the harness ships a single `EmbeddingProvider` realization (`createEmbeddingProvider` in `harness/src/providers/embedding.ts`) that is OpenAI-shaped and pointed at a billing gateway. For a self-contained CLI that works offline, we need an in-process embedding model.

The harness already declares the seam: `EmbeddingProvider.embed(texts, session) → ResultAsync<number[][], ProviderError>` (`harness/src/providers/types.ts:70`), injected at the composition root. The harness never inspects the provider's internals. A CLI-side realization can be injected later without any harness change.

Spike findings (captured in `cli/spike/NOTES.md` on this branch) validated:
- `node-llama-cpp@3.19.0` works on linux-arm64 with prebuilt binaries; `bun install` blocks the postinstall by default, and `bun pm trust node-llama-cpp` triggers the binary fetch on demand.
- `bge-small-en-v1.5-q8_0.gguf` (36.8 MB, CompendiumLabs/bge-small-en-v1.5-gguf, MIT) loads in ~250ms, produces 384-dim vectors at 8–103ms/text on CPU.
- **Critical**: the GGUF quantized model does NOT L2-normalize (raw norm ≈ 9.24). The provider MUST normalize every vector before returning it.

The CLI today calls no harness code and has no embedding consumer. This change builds the provider + setup + config; the vector store and `assembleCoreRuntime` wiring are deferred.

## Goals / Non-Goals

**Goals:**
- A CLI-side `EmbeddingProvider` realization that runs `bge-small-en-v1.5` in-process via `node-llama-cpp`, L2-normalizes vectors, and implements the harness seam.
- `node-llama-cpp` as an optional, lazy-loaded dependency — a plain `bun install` never fetches native binaries; they are fetched at setup-yes time only.
- An interactive embedding setup (`inflexa setup`) that downloads + verifies the GGUF model on user opt-in, and records the choice in config.
- Config-driven mode resolution (`local` | `api-key` | `off`) ready to inject into `assembleCoreRuntime` when the CLI wires the harness.

**Non-Goals:**
- No vector store (sqlite-vec / local pgvector / lancedb). The provider returns `number[][]`; the store is a separate future change.
- No `assembleCoreRuntime` wiring. The CLI does not call the harness today; this change builds the provider, not its consumer.
- No harness changes. The `EmbeddingProvider` seam is already provider-agnostic.
- No dimension parameterization of the harness pgvector path (`search-config.ts:64` hardcodes 1536). Deferred with the store decision.
- No revectorization/mode-switching UX. A future change handles per-analysis dimension tracking + re-embed on mode switch.

## Decisions

### D1: node-llama-cpp as optionalDependency, lazy dynamic import

**Choice**: `node-llama-cpp` in `optionalDependencies`, loaded via `await import("node-llama-cpp")` inside `createLocalEmbeddingProvider` on first `embed()` call. The postinstall (which fetches prebuilt llama.cpp binaries) is blocked by bun's default security policy; the binary fetch is triggered explicitly at setup-yes time via `bun pm trust node-llama-cpp`.

**Rationale**: A plain `bun install` (or `npm install` for end users of the compiled binary) must not fetch ~50 MB of platform-specific native binaries unless the user opted into local embeddings. bun blocks postinstall scripts by default; we lean on that as the gate, then explicitly trust at setup time.

**Alternatives considered**:
- *Hard dependency*: rejected — bloats every install with native binaries most users won't use.
- *Ollama as a sidecar container*: rejected — adds a daemon to manage (a second container alongside CLIProxyAPI), more moving parts, and the user asked for in-process to avoid complexity.
- *bundled prebuilt binaries in the release*: rejected — platform matrix explosion; node-llama-cpp already solves this with its own binary distribution.

### D2: bge-small-en-v1.5 q8_0 GGUF

**Choice**: `CompendiumLabs/bge-small-en-v1.5-gguf` `q8_0` (36.8 MB, 384-dim, 33.2M params, MIT).

**Rationale**: Small enough to download in seconds, runs on CPU at acceptable CLI latency (8–103ms/text), MIT-licensed, and BAAI's bge family is well-regarded on MTEB. The q8_0 quantization gives ~30% CPU speedup over f16 with minimal accuracy loss (per the model card). 384-dim keeps the vector store small when it lands.

**Alternatives considered**:
- *nomic-embed-text (768-dim, 274 MB)*: more popular on Ollama but larger; 768-dim doubles storage vs 384.
- *qwen3-embedding:0.6b (1024-dim, 639 MB)*: higher MTEB but much heavier; overkill for local CLI file-description indexing.
- *f16 GGUF (65 MB)*: 2× the size for negligible accuracy gain at this scale.

### D3: L2-normalize in the provider, not the store

**Choice**: `createLocalEmbeddingProvider` L2-normalizes every vector before returning it from `embed()`.

**Rationale**: The spike proved the GGUF quantized model emits un-normalized vectors (norm ≈ 9.24). Normalizing once at the provider boundary is store-agnostic — whether the future store is pgvector (which handles un-normalized via `<=>`), sqlite-vec, or lancedb, a normalized vector is always safe. It also matches the harness's existing `createEmbeddingProvider` (OpenAI returns normalized vectors), so the two providers are interchangeable without the store knowing.

**Alternatives considered**:
- *Normalize at the store*: rejected — couples normalization to storage, and a future store might use dot-product (which requires normalized vectors).
- *Don't normalize, rely on pgvector cosine*: rejected — only works if the future store is pgvector; locks us in.

### D4: Provider lives CLI-side, not harness-side

**Choice**: `createLocalEmbeddingProvider` lives in `cli/src/modules/embedding/`, passed into `assembleCoreRuntime` as the `embedding` dep when the CLI wires the harness.

**Rationale**: The harness ships "zero cloud deps" OSS realizations; `node-llama-cpp` is a heavy native dep that cloud embedders never need. Putting it in the harness would bloat every harness consumer. The CLI is the embedder that needs local embeddings; the realization stays with it. This matches AGENTS.md: "CLI wires harness seams to local realizations."

**Alternatives considered**:
- *Second OSS realization in harness/src/providers/*: rejected — violates the harness's lightweight-OSS-realization principle; cloud embedders would pull node-llama-cpp transitively.

### D5: Setup lifecycle mirrors proxy/setup.ts

**Choice**: The embedding setup reuses the patterns from `modules/proxy/setup.ts`: interactive question in the `inflexa setup` flow, download on opt-in, verify (load + embed probe + dim check), record in config. A dedicated `ensureEmbedderReady()` hot-path gate mirrors `ensureProxyReady()`.

**Rationale**: Consistency with the existing setup UX. The proxy module already solved "download a thing, verify it, make it ready for the TUI hot path" — we follow that template rather than inventing a new lifecycle.

### D6: Config schema extension

**Choice**: Add to `config.json`:
```json
{
  "embedding": {
    "mode": "local" | "api-key" | "off",
    "modelPath": "<path to GGUF>",   // present when mode === "local"
    "apiKey": "<key>"                // present when mode === "api-key"
  }
}
```
Default: `{ "mode": "off" }` — embeddings are not configured until the user runs setup.

**Rationale**: The existing config schema (`lib/config.ts`) uses zod with `.catch()` defaults for forward-compat. Adding `embedding` with a zod object + enum is the established pattern (mirrors `runtime`, `theme`).

## Risks / Trade-offs

- **[Risk] node-llama-cpp binary fetch fails on exotic platforms** → The package falls back to building from source with cmake; if that fails too, `createLocalEmbeddingProvider` returns a clear `ProviderError` (not a crash). Setup detects the failure and falls back to `mode: "off"` or prompts for `api-key`.
- **[Risk] GGUF tokenizer warning** → node-llama-cpp prints `special_eos_id is not in special_eog_ids` and a detokenization mismatch warning. Spike confirmed this is cosmetic — embeddings are correct. No mitigation needed; document it.
- **[Trade-off] 384-dim vs 1536-dim** → `bge-small-en-v1.5` is 384-dim; the harness's cloud path is 1536-dim. They cannot share a pgvector table. This is fine: per-analysis indexes are created fresh (one-line `dimension` param), and the store is deferred. A future mode-switch will need per-analysis revectorization — accepted as a future concern.
- **[Trade-off] No batch embedding API** → node-llama-cpp's embedding context embeds one text at a time (`getEmbeddingFor`); the docs suggest `Promise.all` for concurrency. The provider will concurrency-cap (e.g. 4 parallel) to avoid overwhelming CPU on large batches. Acceptable for CLI-scale indexing (10–50 file descriptions per step).
- **[Risk] Model file deleted/missing after setup** → `ensureEmbedderReady()` detects a missing GGUF and re-prompts setup, mirroring the proxy's `isAuthenticated()` check. The provider's lazy init fails with a clear `ProviderError` if the file vanishes at runtime.
- **[Trade-off] First-embed latency** → Runtime init (~750ms) + model load (~250ms) happen on the first `embed()` call. Accepted — it's a one-time cost, and the lazy init means the CLI starts fast if embeddings aren't used.
