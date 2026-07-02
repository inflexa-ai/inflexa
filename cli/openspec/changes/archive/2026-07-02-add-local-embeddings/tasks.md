## 1. Config + env foundation

- [x] 1.1 Add `embedding` to the config schema in `src/lib/config.ts`: `z.object({ mode: z.enum(["local","api-key","off"]).catch("off").default("off"), modelPath: z.string().optional(), apiKey: z.string().optional() })`. Update the `readConfig` fallback to include `embedding: { mode: "off" }`.
- [x] 1.2 Add `modelDir` and `embeddingModelPath` to `env` in `src/lib/env.ts` (`<dataDir>/inflexa/models/` and `<modelDir>/bge-small-en-v1.5-q8_0.gguf`). Add both to `envDoc` for `--help`.
- [x] 1.3 Run `bun run typecheck` — confirm the config/env changes compile.

## 2. Local embedding provider

- [x] 2.1 Create `src/modules/embedding/local-provider.ts` with `createLocalEmbeddingProvider(deps: { modelPath: string }): EmbeddingProvider`. Dynamic `import("node-llama-cpp")` on first `embed()`; lazy `getLlama()` + `loadModel()` + `createEmbeddingContext()`.
- [x] 2.2 Implement `embed(texts, session)`: empty input → `okAsync([])`; per-text `context.getEmbeddingFor(text).vector`, L2-normalized, concurrency-capped at 4 via a simple pool. Wrap node-llama-cpp throws into `ProviderError` via `toProviderError`. Ignore `session` (local, no billing).
- [x] 2.3 Handle the dynamic-import-failure case: if `import("node-llama-cpp")` rejects, return `err(ProviderError)` with a "run `inflexa setup --embeddings`" message — do not throw.
- [x] 2.4 Write a unit test (`local-provider.test.ts`) using a mock or the real model (gated by model-file presence) that asserts: dim === 384, L2 norm ≈ 1.0, empty input → `ok([])`.

## 3. Mode resolution

- [x] 3.1 Create `src/modules/embedding/resolve.ts` with `resolveEmbedder(config: Config): Result<EmbeddingProvider, EmbeddingResolveError>`. `local` → `createLocalEmbeddingProvider`; `api-key` → harness `createEmbeddingProvider`; `off` → `err({ type: "embeddings_not_configured" })`.
- [x] 3.2 Define `EmbeddingResolveError` as a discriminated union (`embeddings_not_configured` | `local_model_missing` | `api_key_missing`).
- [x] 3.3 Write a unit test for each mode path + the error cases.

## 4. Model download + verify (setup lifecycle)

- [x] 4.1 Create `src/modules/embedding/setup.ts` with `downloadModel(): Promise<Result<void, EmbeddingSetupError>>` — fetch `bge-small-en-v1.5-q8_0.gguf` from `https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf` to `env.embeddingModelPath`, with progress output. Skip if the file already exists.
- [x] 4.2 Implement `verifyModel(modelPath): Promise<Result<void, EmbeddingSetupError>>` — load the model via node-llama-cpp, embed a probe text, assert dim === 384. Return `err` on load failure or dimension mismatch.
- [x] 4.3 Implement `runEmbeddingSetup(interactive: boolean): Promise<Result<void, EmbeddingSetupError>>` — the interactive prompt ("Use local embeddings? [Y/n]"), opt-in gate, trigger `bun pm trust node-llama-cpp` for native binaries, download, verify, write `embedding.mode = "local"` + `embedding.modelPath` to config. Skip cleanly in non-TTY.
- [x] 4.4 Implement `ensureEmbedderReady(): Promise<Result<void, EmbeddingSetupError>>` — for `mode === "local"`, check `env.embeddingModelPath` exists; return `err` directing to `inflexa setup` if missing. For `mode === "off"` or `api-key`, return `ok`.
- [x] 4.5 Define `EmbeddingSetupError` as a discriminated union (`download_failed` | `verify_failed` | `dimension_mismatch` | `not_configured`).

## 5. Wire into `inflexa setup`

- [x] 5.1 In `src/modules/proxy/setup.ts`, call `runEmbeddingSetup(process.stdin.isTTY)` after the provider-auth block in both `setup()` and `ensureProxyReady()`. The embedding question runs after auth, before "Done."
- [x] 5.2 Add an `--embeddings <mode>` flag to the `setup` command in `src/cli/index.ts` (optional; overrides the interactive prompt with `local` | `api-key` | `off`).
- [x] 5.3 Update the setup command's help text / `printNextSteps` to mention the embedding choice.

## 6. Dependency declaration

- [x] 6.1 Add `node-llama-cpp` to `optionalDependencies` in `cli/package.json` (NOT `dependencies`). Pin to `^3.19.0`.
- [x] 6.2 Run `bun install` and confirm the postinstall is blocked (no `node_modules/@node-llama-cpp/<platform>/bins/*.node`). Run `bun pm trust node-llama-cpp` and confirm binaries appear.

## 7. Validation

- [x] 7.1 Run `bun run typecheck` — zero errors.
- [x] 7.2 Run `bun run lint` — zero errors.
- [x] 7.3 Run `bun test` — all existing + new tests pass.
- [x] 7.4 Manual smoke: `inflexa setup` in a TTY → opt into local embeddings → confirm GGUF downloads, config written, `ensureEmbedderReady()` passes.
- [x] 7.5 Manual smoke: `inflexa setup` in a non-TTY → confirm embedding question skipped, no hang.
- [x] 7.6 Clean up spike artifacts: remove `cli/spike/` once the provider tests cover the same validation.
