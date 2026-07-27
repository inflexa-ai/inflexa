# local-embeddings delta — hardening

## MODIFIED Requirements

### Requirement: Embedding mode is config-driven

`cli/src/lib/config.ts` SHALL extend the config schema with an `embedding` object: `{ mode: "local" | "api-key" | "off", modelPath?: string, apiKey?: string, baseURL?: string, model?: string, dimensions?: number }` — the ONE config surface for embeddings (there is no separate `harness.embedding` key). The default SHALL be `{ mode: "off" }`. `resolveEmbedder(config)` in `src/modules/embedding/resolve.ts` SHALL return a `ResultAsync<number[][], ProviderError>`-producing `EmbeddingProvider` based on `mode`: `local` → `createLocalEmbeddingProvider` sized to `embedding.dimensions` (the width the harness sizes each index to — unset for the built-in bge-small, where the provider defaults to 384; a custom GGUF's recorded width otherwise), `api-key` → the harness `createEmbeddingProvider` connecting DIRECTLY to the configured OpenAI-compatible endpoint (default `https://api.openai.com/v1` + `text-embedding-3-small` + 1536 — never through the chat proxy, which serves no embeddings route), `off` → an error indicating embeddings are not configured. The provider SHALL advertise its vector width via `dimensions`, which the harness uses to size each per-analysis search index.

#### Scenario: Default config has embeddings off

- **WHEN** a fresh config is read with no `embedding` key
- **THEN** the parsed config SHALL have `embedding.mode === "off"`

#### Scenario: Local mode resolves to the local provider

- **WHEN** `resolveEmbedder` is called with a config where `embedding.mode === "local"` and `embedding.modelPath` is set
- **THEN** it SHALL return a `createLocalEmbeddingProvider` instance

#### Scenario: Local mode honors a configured dimensions

- **WHEN** `resolveEmbedder` is called with `embedding.mode === "local"`, a `modelPath`, and `embedding.dimensions === 768`
- **THEN** the returned provider SHALL advertise `dimensions === 768` (a custom GGUF's width), and with `dimensions` unset SHALL advertise the built-in default of 384

#### Scenario: Off mode resolves to an error

- **WHEN** `resolveEmbedder` is called with a config where `embedding.mode === "off"`
- **THEN** it SHALL return `err` indicating embeddings are not configured

#### Scenario: Switching backends warns about stranded indexes

- **WHEN** setup is asked to select an embedding backend whose EFFECTIVE VECTOR WIDTH may differ from the currently configured backend's — a different non-`off` mode, or a `local` → `local` switch to a different model path (whose width is unknown until verified)
- **THEN** it SHALL warn loudly that existing analyses' search indexes keep the previous backend's vector width and fail for search and further indexing until re-profiled (automatic re-embedding is deliberately unsupported for now)

#### Scenario: A same-width backend re-selection does not warn

- **WHEN** setup re-selects the currently configured backend unchanged (same mode, same model path)
- **THEN** no stranding warning is printed — nothing about the index width can change

### Requirement: Embedding setup offers the built-in model, a custom GGUF, or api-key

`inflexa setup` SHALL let the user pick an embedding backend via a `select` picker offering four choices: the BUILT-IN model, the user's OWN local GGUF (a path they supply), an API-key endpoint, or off. Picker copy SHALL match the install context — the built-in choice SHALL NOT claim it downloads the model in a compiled binary, where it is an embedded asset.

For the BUILT-IN model, setup SHALL materialize the sidecar runtime (per the acquisition requirement) and acquire `bge-small-en-v1.5-q8_0.gguf` (~36 MB) to `env.embeddingModelPath` source-aware, mirroring runtime acquisition: the compiled binary SHALL copy the model from its build-time embedded asset with no network access; a source checkout SHALL download the pinned revision from `CompendiumLabs/bge-small-en-v1.5-gguf` on HuggingFace. Both sources SHALL be verified against the vendored SHA-256 before any bytes land at `env.embeddingModelPath` — staged beside the final path and atomically renamed — then verified end-to-end through the sidecar, ASSERTING the vector dimension is 384 (the model is SHA-256-pinned, so any other width means a corrupt asset). On success it SHALL write `embedding.mode = "local"` and `embedding.modelPath = env.embeddingModelPath` (no `dimensions` — the provider defaults to 384).

For a CUSTOM GGUF, setup SHALL prompt for a file path, confirm the file exists, materialize the runtime, and verify through the sidecar WITHOUT asserting a fixed width — MEASURING whatever width the model emits. It SHALL NOT acquire anything: the file is the user's, so nothing is copied or downloaded. On success it SHALL write `embedding.mode = "local"`, `embedding.modelPath = <the supplied path>`, and `embedding.dimensions = <the measured width>` when that differs from the built-in 384 (recording it so the harness sizes each index to what the model emits). A zero-width or failed probe SHALL leave `embedding.mode` unchanged.

For api-key or off, no model SHALL be acquired. An embedding-mode answer (`--embeddings local|api-key|off`; file `embedding.mode`) SHALL select the backend non-interactively. An answered `off` SHALL persist `embedding.mode = "off"` — an answer declares desired state, so it disables a previously configured backend (model files on disk are untouched); this is distinct from the interactive picker's "Off / skip" choice, which continues to leave the mode unchanged. `local` with a GGUF answer (`--embeddings-gguf <path>`; file `embedding.gguf`) SHALL select the CUSTOM-GGUF branch non-interactively — the answer replaces the interactive path prompt, and the same exists-check, runtime materialization, and measured-width verification run; `local` without one is the BUILT-IN model. `api-key` SHALL take its endpoint and model as answers (`--embeddings-url`, `--embeddings-model`; file `embedding.baseURL`, `embedding.model`) with the secret from the `INFLEXA_EMBEDDING_API_KEY` environment variable — required under batch resolution, where the masked prompt cannot run; interactively, answered fields skip their prompts and the key prompt still runs when the variable is unset. When the variable IS set, an interactive run SHALL state that the key is being read from `INFLEXA_EMBEDDING_API_KEY` (mirroring the model-key environment notice) instead of silently skipping the masked prompt — a stale exported key must be visible at the moment it is adopted. Verification through the sidecar SHALL be the same in the compiled binary and from source.

#### Scenario: User picks the built-in model in the compiled binary

- **WHEN** the user picks the built-in model in the compiled binary
- **THEN** the model SHALL be copied from the embedded asset to `env.embeddingModelPath` with no network access
- **AND** verified against the vendored SHA-256 before landing at the final path
- **AND** the sidecar SHALL serve a probe embedding whose dimension is asserted to be 384
- **AND** config SHALL be updated with `embedding.mode = "local"` and `embedding.modelPath` (no `dimensions`)

#### Scenario: User picks the built-in model in a source checkout

- **WHEN** the user picks the built-in model in a source checkout
- **THEN** the pinned model revision SHALL be downloaded from HuggingFace, verified against the vendored SHA-256, and landed at `env.embeddingModelPath`
- **AND** the sidecar SHALL serve a probe embedding whose dimension is asserted to be 384
- **AND** config SHALL be updated with `embedding.mode = "local"` and `embedding.modelPath`

#### Scenario: User points at their own GGUF

- **WHEN** the user picks "your own local model" and supplies a path to an existing GGUF
- **THEN** setup SHALL NOT copy or download anything — the file stays where it is
- **AND** the sidecar SHALL serve a probe embedding whose width is MEASURED (not asserted at 384)
- **AND** config SHALL be updated with `embedding.mode = "local"`, that `modelPath`, and `embedding.dimensions` set to the measured width when it differs from 384

#### Scenario: A custom GGUF path that does not exist is rejected

- **WHEN** the user supplies a path with no file at it
- **THEN** setup SHALL report an actionable error naming the path and leave `embedding.mode` unchanged

#### Scenario: User declines embeddings

- **WHEN** the user selects off
- **THEN** no model SHALL be acquired and no runtime SHALL be materialized
- **AND** config SHALL remain `embedding.mode = "off"` (or prompt for api-key)

#### Scenario: Model already present is not re-downloaded

- **WHEN** the user picks the built-in model and `env.embeddingModelPath` already exists
- **THEN** acquisition SHALL be skipped (no download, no embedded-asset copy)
- **AND** verification (sidecar probe) SHALL still run

#### Scenario: Checksum mismatch leaves nothing at the final path

- **WHEN** the acquired built-in bytes (from either source) fail SHA-256 verification
- **THEN** setup SHALL report an actionable error and nothing SHALL be left at `env.embeddingModelPath`

#### Scenario: Verification fails

- **WHEN** the sidecar cannot serve a valid probe embedding for the chosen model (built-in: a non-384 width; either: a zero-width or start failure)
- **THEN** setup SHALL report the error and leave `embedding.mode` unchanged (not "local")

#### Scenario: An answered off disables a configured backend

- **WHEN** `setup --yes --embeddings off` runs on a machine whose config has `embedding.mode = "local"`
- **THEN** `embedding.mode` is written to `"off"` and the model files on disk are left untouched

#### Scenario: A GGUF answer selects the custom branch non-interactively

- **WHEN** `setup --yes --embeddings local --embeddings-gguf /models/my.gguf` runs and the file exists
- **THEN** the custom branch runs with no path prompt — the sidecar measures the width, and config records that `modelPath` (and `dimensions` when non-384)

#### Scenario: Batch api-key embeddings run from answers and the env secret

- **WHEN** `setup --yes --embeddings api-key --embeddings-url https://gw.corp/v1 --embeddings-model my-embed` runs with `INFLEXA_EMBEDDING_API_KEY` set
- **THEN** the endpoint probe runs with the env key and, on a pass, config records `mode = "api-key"`, the key, and the non-default fields — with no prompt shown

#### Scenario: An exported embedding key is adopted with a notice

- **WHEN** an interactive run picks api-key embeddings while `INFLEXA_EMBEDDING_API_KEY` is exported
- **THEN** the masked key prompt is skipped, and the run states the key is being read from `INFLEXA_EMBEDDING_API_KEY` before persisting it

#### Scenario: A failing batch endpoint probe leaves the mode unchanged

- **WHEN** `setup --yes --embeddings api-key --embeddings-url https://gw.corp/v1` runs with the env secret set and the endpoint probe fails
- **THEN** setup exits non-zero showing the probe failure and `embedding.mode` is unchanged
