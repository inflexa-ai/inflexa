## 1. Provider & resolution (`cli/src/modules/embedding/`)

- [x] 1.1 `local-provider.ts`: `createLocalEmbeddingProvider` takes `deps.dimensions` and uses that ONE value for both the sidecar request width and the advertised `provider.dimensions`, defaulting to the exported `LOCAL_EMBEDDING_DIMENSIONS` (384) when unset; document why the two can never disagree
- [x] 1.2 `resolve.ts`: `local` mode passes `config.embedding.dimensions` through to `createLocalEmbeddingProvider` (unset → the built-in 384; a custom GGUF's recorded width otherwise)

## 2. Setup (`cli/src/modules/embedding/setup.ts`)

- [x] 2.1 Replace the three-mode picker with a four-way backend `select`: built-in model, the user's own GGUF, api-key, off; picker copy is install-context-aware (no "download" claim in a compiled binary); `--embeddings local` selects the built-in model only (custom paths are interactive-only)
- [x] 2.2 Built-in branch: materialize the runtime, acquire the pinned bge-small, verify ASSERTING 384, write `mode = "local"` + `modelPath = env.embeddingModelPath` (no `dimensions`)
- [x] 2.3 Custom branch: prompt for a path, confirm the file exists, materialize the runtime, verify MEASURING the emitted width, write `mode = "local"` + that `modelPath` + `dimensions` only when it differs from 384; a non-existent path is an actionable error leaving `mode` unchanged
- [x] 2.4 `verifyModel` measures the width the sidecar emits; `expectedDim` gates only the built-in's 384 assertion; a zero-width probe is `verify_failed` for either branch
- [x] 2.5 `ensureEmbedderReady` gates the CONFIGURED `embedding.modelPath` (fall back to `env.embeddingModelPath` only when none is recorded), so a custom GGUF at the user's own path passes; still no sidecar spawn or re-verify beyond one-time runtime materialization

## 3. api-key model discovery (`cli/src/modules/embedding/api_models.ts`, new)

- [x] 3.1 `listEmbeddingModels(baseURL, apiKey)` fetches `{baseURL}/models`, filters to embedding-capable ids (`/embed/i`), sorts, and never throws — every fault (bad URL, unreachable, non-2xx, unparseable body, empty/filtered-to-nothing) is a caller-degradable error
- [x] 3.2 Credential-leak guard runs before any fetch: refuse to send the api key over cleartext `http://` to a non-loopback host (loopback exempt for local inference servers)
- [x] 3.3 Its own module, NOT a parameter on `modules/proxy/models.ts` — document that the proxy list is chat-only and hardwired to the local proxy, while this backend talks directly to a user-supplied endpoint

## 4. `inflexa config` (`cli/src/tui/app_config.tsx`)

- [x] 4.1 Render embeddings as ONE summary row naming the active backend and its distinguishing detail; no inactive-backend fields; the api key is never printed on the row
- [x] 4.2 Activating the row opens a `SelectDialog` backend picker; the choice drives per-backend follow-ups built from existing `SelectDialog` / `PromptDialog` / `FilePicker`; each step closes before pushing the next; the draft's embedding block is replaced wholesale only at a branch's final step, so cancelling any step aborts cleanly
- [x] 4.3 Width is ENTERED (not measured — this screen never spawns the sidecar); a non-positive-integer entry is rejected inline; editing writes `config.json` only (no acquire/download/verify)
- [x] 4.4 api-key flow: key → base URL → fetched embedding-model selection, degrading to free-text model entry on a failed/empty/unusable listing → width

## 5. CLI copy

- [x] 5.1 `--embeddings` help names `local` as the built-in bge-small model; the setup next-steps copy points the user at `inflexa setup`'s picker (built-in / own GGUF / api-key) and `inflexa config`

## 6. Tests (`cli/src/modules/embedding/*.test.ts`)

- [x] 6.1 `resolve`: `local` mode honors a configured `dimensions` (768) and defaults to 384 when unset
- [x] 6.2 `setup`: built-in asserts 384; custom measures and records `dimensions` only when it differs from 384; a missing custom path is rejected; the readiness gate honors the configured path over the built-in location
- [x] 6.3 `api_models` (new): embedding-id filtering, the cleartext-http credential guard, and degradation to free-text on a failed/empty listing
- [x] 6.4 `local-provider`: the advertised width follows `deps.dimensions` (custom width vs the 384 default)

## 7. Verify

- [x] 7.1 `bun run format:file` on touched `src/` files; `bun run typecheck`, `bun run lint`, full `bun test` green
