## Purpose

Local, in-process text embeddings for the cli: a `node-llama-cpp`-backed realization of the harness `EmbeddingProvider` seam (bge-small GGUF, no API key), the mode-based `embedding` config key that selects between it and a direct OpenAI-compatible endpoint, and the setup flow that downloads, verifies, and records the choice.

## Requirements

### Requirement: Local embedding provider realizes the harness EmbeddingProvider seam

The CLI SHALL provide `createLocalEmbeddingProvider(deps): EmbeddingProvider` from `src/modules/embedding/local-provider.ts`, where `EmbeddingProvider` is the harness interface (`embed(texts, session) → ResultAsync<number[][], ProviderError>`). The provider SHALL load `bge-small-en-v1.5` (GGUF, q8_0) in-process via `node-llama-cpp`. The `node-llama-cpp` import SHALL be a dynamic `import()` evaluated lazily on the first `embed()` call — it SHALL NOT be a static top-level import, so a process that never embeds never loads the native runtime.

#### Scenario: Provider implements the harness seam

- **WHEN** `createLocalEmbeddingProvider` is called with `{ modelPath }`
- **THEN** it returns an object with an `embed(texts, session)` method
- **AND** the method's return type is `ResultAsync<number[][], ProviderError>`

#### Scenario: Lazy native runtime load

- **WHEN** `createLocalEmbeddingProvider` is called
- **THEN** `node-llama-cpp` is NOT imported at construction time
- **AND** the llama runtime is NOT initialized
- **WHEN** `embed()` is called for the first time
- **THEN** `node-llama-cpp` is dynamically imported
- **AND** `getLlama()` + `loadModel()` are invoked

#### Scenario: node-llama-cpp not installed

- **WHEN** `embed()` is called and the dynamic `import("node-llama-cpp")` fails
- **THEN** the provider SHALL return `err(ProviderError)` with a message directing the user to run `inflexa setup --embeddings`
- **AND** it SHALL NOT throw

### Requirement: Embedding vectors are 384-dimensional and L2-normalized

Every vector returned by `createLocalEmbeddingProvider.embed()` SHALL have exactly 384 dimensions and SHALL be L2-normalized (Euclidean norm ≈ 1.0). The GGUF quantized model emits un-normalized vectors (norm ≈ 9.24); the provider SHALL normalize each vector by dividing every component by its Euclidean norm before returning it.

#### Scenario: Vector dimension is 384

- **WHEN** `embed(["some text"], session)` resolves to `ok(vectors)`
- **THEN** `vectors[0].length` SHALL equal 384

#### Scenario: Vectors are L2-normalized

- **WHEN** `embed(["some text"], session)` resolves to `ok(vectors)`
- **THEN** `Math.sqrt(vectors[0].reduce((s, v) => s + v*v, 0))` SHALL be within 0.001 of 1.0

#### Scenario: Empty input returns empty output

- **WHEN** `embed([], session)` is called
- **THEN** it SHALL resolve to `ok([])` without loading the model

### Requirement: Embedding concurrency is capped

The provider SHALL embed multiple texts concurrently via `Promise.all` over individual `context.getEmbeddingFor()` calls, capped at a maximum of 4 concurrent embeddings to avoid saturating CPU on large batches.

#### Scenario: Batch embedding respects concurrency cap

- **WHEN** `embed([text1, text2, ..., text10], session)` is called
- **THEN** no more than 4 `getEmbeddingFor` calls SHALL be in-flight simultaneously

### Requirement: node-llama-cpp is an optional, lazily-fetched dependency

`node-llama-cpp` SHALL be declared in `cli/package.json` under `optionalDependencies` (not `dependencies`). A plain `bun install` SHALL NOT fetch prebuilt llama.cpp native binaries — the postinstall SHALL be blocked by default. The native binaries SHALL be fetched on demand at setup-yes time via `bun pm trust node-llama-cpp` (or equivalent).

#### Scenario: Plain install does not fetch native binaries

- **WHEN** `bun install` runs without prior setup
- **THEN** `node-llama-cpp` JS is installed but `node_modules/@node-llama-cpp/<platform>/bins/` SHALL NOT contain the native `.node` addon
- **AND** the postinstall script SHALL NOT have run

#### Scenario: Setup-yes triggers binary fetch

- **WHEN** the user opts into local embeddings during `inflexa setup`
- **THEN** the setup process SHALL trigger the native binary fetch (via `bun pm trust` or direct postinstall invocation)
- **AND** the platform-specific `.node` addon SHALL be present in `node_modules/@node-llama-cpp/<platform>/bins/`

### Requirement: Embedding mode is config-driven

`cli/src/lib/config.ts` SHALL extend the config schema with an `embedding` object: `{ mode: "local" | "api-key" | "off", modelPath?: string, apiKey?: string, baseURL?: string, model?: string, dimensions?: number }` — the ONE config surface for embeddings (there is no separate `harness.embedding` key). The default SHALL be `{ mode: "off" }`. `resolveEmbedder(config)` in `src/modules/embedding/resolve.ts` SHALL return a `ResultAsync<number[][], ProviderError>`-producing `EmbeddingProvider` based on `mode`: `local` → `createLocalEmbeddingProvider` (384-dim), `api-key` → the harness `createEmbeddingProvider` connecting DIRECTLY to the configured OpenAI-compatible endpoint (default `https://api.openai.com/v1` + `text-embedding-3-small` + 1536 — never through the chat proxy, which serves no embeddings route), `off` → an error indicating embeddings are not configured. The provider SHALL advertise its vector width via `dimensions`, which the harness uses to size each per-analysis search index.

#### Scenario: Default config has embeddings off

- **WHEN** a fresh config is read with no `embedding` key
- **THEN** the parsed config SHALL have `embedding.mode === "off"`

#### Scenario: Local mode resolves to the local provider

- **WHEN** `resolveEmbedder` is called with a config where `embedding.mode === "local"` and `embedding.modelPath` is set
- **THEN** it SHALL return a `createLocalEmbeddingProvider` instance

#### Scenario: Off mode resolves to an error

- **WHEN** `resolveEmbedder` is called with a config where `embedding.mode === "off"`
- **THEN** it SHALL return `err` indicating embeddings are not configured

#### Scenario: Switching backends warns about stranded indexes

- **WHEN** setup is asked to select an embedding mode while `embedding.mode` is already a different non-`off` mode
- **THEN** it SHALL warn loudly that existing analyses' search indexes keep the previous backend's vector width and fail for search and further indexing until re-profiled (automatic re-embedding is deliberately unsupported for now)

### Requirement: Embedding setup downloads and verifies the model on opt-in

`inflexa setup` SHALL ask the user whether to use local embeddings. If yes, it SHALL download `bge-small-en-v1.5-q8_0.gguf` (~36 MB) from `CompendiumLabs/bge-small-en-v1.5-gguf` on HuggingFace to `env.embeddingModelPath`, then verify it by loading the model, embedding a probe text, and asserting the vector dimension is 384. On success, it SHALL write `embedding.mode = "local"` and `embedding.modelPath` to config. The download SHALL NOT occur if the user declines.

#### Scenario: User opts into local embeddings

- **WHEN** the user is prompted "Use local embeddings?" and selects yes
- **THEN** the GGUF model SHALL be downloaded to `env.embeddingModelPath`
- **AND** the model SHALL be loaded and a probe embedding SHALL be generated
- **AND** the probe vector dimension SHALL be verified as 384
- **AND** config SHALL be updated with `embedding.mode = "local"` and `embedding.modelPath`

#### Scenario: User declines local embeddings

- **WHEN** the user is prompted "Use local embeddings?" and selects no
- **THEN** no model SHALL be downloaded
- **AND** no native binaries SHALL be fetched
- **AND** config SHALL remain `embedding.mode = "off"` (or prompt for api-key)

#### Scenario: Model already present is not re-downloaded

- **WHEN** the user opts into local embeddings and `env.embeddingModelPath` already exists
- **THEN** the download SHALL be skipped
- **AND** verification (load + probe) SHALL still run

#### Scenario: Verification fails

- **WHEN** the downloaded model fails to load or produces vectors of the wrong dimension
- **THEN** setup SHALL report the error and leave `embedding.mode` unchanged (not "local")

### Requirement: Embedding model path is env-managed

`cli/src/lib/env.ts` SHALL expose `env.modelDir` (`<dataDir>/inflexa/models/`) and `env.embeddingModelPath` (`<modelDir>/bge-small-en-v1.5-q8_0.gguf`). These SHALL be included in `envDoc` for `--help` visibility.

#### Scenario: Model path resolves under the data dir

- **WHEN** `env.embeddingModelPath` is read
- **THEN** it SHALL be `<dataDir>/inflexa/models/bge-small-en-v1.5-q8_0.gguf`

#### Scenario: Model dir appears in help

- **WHEN** `inflexa --help` is run
- **THEN** the paths section SHALL list the models directory

### Requirement: Embedder readiness gate for the hot path

`ensureEmbedderReady()` in `src/modules/embedding/setup.ts` SHALL mirror `ensureProxyReady()`: for `mode === "local"`, it SHALL check that the GGUF model file exists and is loadable, returning `Result<void, EmbeddingSetupError>`. It SHALL NOT re-download or re-verify on every call — a file-exists check is sufficient for the hot path. A missing file SHALL return an error directing the user to `inflexa setup`.

#### Scenario: Model present and readable

- **WHEN** `ensureEmbedderReady()` is called and `env.embeddingModelPath` exists
- **THEN** it SHALL return `ok(undefined)`

#### Scenario: Model missing

- **WHEN** `ensureEmbedderReady()` is called and `env.embeddingModelPath` does not exist
- **THEN** it SHALL return `err` with a message directing the user to run `inflexa setup --embeddings`

### Requirement: Embedding setup is wired into the interactive setup flow

The interactive `inflexa setup` questionnaire SHALL include an embedding-mode question after provider auth. The question SHALL be skippable (defaulting to `off`). Non-interactive shells (no TTY) SHALL skip the embedding question without hanging, leaving `mode` unchanged.

#### Scenario: Interactive setup asks about embeddings

- **WHEN** `inflexa setup` runs in a TTY
- **THEN** the user SHALL be prompted to choose an embedding mode after provider auth

#### Scenario: Non-interactive setup skips embeddings

- **WHEN** `inflexa setup` runs without a TTY
- **THEN** the embedding question SHALL be skipped
- **AND** `embedding.mode` SHALL remain unchanged
