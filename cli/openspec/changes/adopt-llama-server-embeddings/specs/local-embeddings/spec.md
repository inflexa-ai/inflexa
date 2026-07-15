## ADDED Requirements

### Requirement: Sidecar runtime acquisition is pinned, verified, and atomic

The local embedding runtime SHALL be an official prebuilt `llama.cpp` release archive (containing `llama-server` and its companion shared libraries), pinned to an exact release tag per platform with SHA-256 checksums vendored in this repository — upstream publishes none, so the vendored hash is the sole integrity authority. The macOS arm64 pin SHALL be a build compatible with the product's supported macOS versions (current upstream macOS builds require macOS 26). Acquisition SHALL be source-aware: the compiled binary carries its own platform's archive as a build-time embedded asset (each target embeds exactly one); a source checkout downloads the identical pinned artifact. Both sources SHALL converge on one materialization step: verify the SHA-256, extract the complete archive directory (the server resolves its shared libraries relative to itself), and atomically rename into a tag-named directory under the data dir — a partial or failed materialization SHALL leave no trace at the final path, and re-running SHALL converge (an already-materialized tag directory is reused without network or extraction).

#### Scenario: Compiled binary materializes from the embedded asset

- **WHEN** local mode first needs the runtime in the compiled binary
- **THEN** the embedded archive is extracted (never read by native code in place), hash-verified, and atomically renamed into the tag-named runtime directory, with no network access

#### Scenario: Source checkout downloads the pinned artifact

- **WHEN** local mode first needs the runtime in a source checkout
- **THEN** the pinned release archive is downloaded, verified against the vendored SHA-256, and materialized into the identical layout

#### Scenario: Hash mismatch is fatal and clean

- **WHEN** the downloaded or embedded archive fails SHA-256 verification
- **THEN** materialization fails with an actionable error and nothing is left at the final runtime path

#### Scenario: Already materialized is a no-op

- **WHEN** the tag-named runtime directory already exists
- **THEN** no download, extraction, or verification work is repeated

### Requirement: Sidecar lifecycle is lazy, loopback-only, and reaped

The provider SHALL spawn `llama-server` lazily on first `embed()` (a process that never embeds never spawns it), bind it to `127.0.0.1` on an ephemerally allocated free port, and protect it with a per-spawn minted API key — the readiness probe authenticates, so a foreign process on the same port can never be mistaken for the sidecar. The server SHALL be reused for the remainder of the CLI process and SHALL be terminated via the process shutdown path (SIGTERM), never leaked past a normal exit. Readiness SHALL be gated on the server's health endpoint with a timeout generous enough for the one-time first-run OS scan of fresh binaries. Embedding requests SHALL guard the model's 512-token per-input ceiling client-side (truncate or chunk before sending) — an over-length input must never surface as a raw server error.

#### Scenario: Lazy spawn and reuse

- **WHEN** `embed()` is called for the first time
- **THEN** the sidecar is spawned, health-checked, and used — and subsequent `embed()` calls in the same process reuse it without a new spawn

#### Scenario: No embed, no sidecar

- **WHEN** a CLI process never calls `embed()`
- **THEN** no sidecar process is ever spawned

#### Scenario: Shutdown reaps the sidecar

- **WHEN** the CLI process exits normally
- **THEN** the sidecar receives SIGTERM and does not outlive the CLI

#### Scenario: Over-length input is guarded

- **WHEN** an input longer than the model's 512-token ceiling is embedded
- **THEN** the provider truncates or chunks it client-side and returns a valid embedding, never a raw server error

## MODIFIED Requirements

### Requirement: Local embedding provider realizes the harness EmbeddingProvider seam

The CLI SHALL provide `createLocalEmbeddingProvider(deps): EmbeddingProvider` from `src/modules/embedding/local-provider.ts`, where `EmbeddingProvider` is the harness interface (`embed(texts, session) → ResultAsync<number[][], ProviderError>`). The provider SHALL run `bge-small-en-v1.5` (GGUF, q8_0) via the pinned `llama-server` sidecar and SHALL transport embeddings through the harness's existing OpenAI-shaped embedding provider pointed at the sidecar's loopback endpoint with `dimensions: 384` — no bespoke wire client. The realization SHALL be identical in the compiled binary and in a source checkout. Failures (runtime not materializable, sidecar failed to start or become healthy) SHALL be returned as `err(ProviderError)` with actionable remediation — never thrown.

#### Scenario: Provider implements the harness seam

- **WHEN** `createLocalEmbeddingProvider` is called with `{ modelPath }`
- **THEN** it returns an object with an `embed(texts, session)` method
- **AND** the method's return type is `ResultAsync<number[][], ProviderError>`

#### Scenario: One realization in both install contexts

- **WHEN** the same texts are embedded from the compiled binary and from a source checkout
- **THEN** both go through the sidecar-backed provider and produce equivalent 384-dim vectors

#### Scenario: Sidecar failure is an error value

- **WHEN** the sidecar cannot be materialized or does not become healthy
- **THEN** the provider returns `err(ProviderError)` with actionable remediation
- **AND** it SHALL NOT throw

### Requirement: Embedding setup downloads and verifies the model on opt-in

`inflexa setup` SHALL ask the user whether to use local embeddings. If yes, it SHALL ensure the sidecar runtime is materialized (per the acquisition requirement) and download `bge-small-en-v1.5-q8_0.gguf` (~36 MB) from `CompendiumLabs/bge-small-en-v1.5-gguf` on HuggingFace to `env.embeddingModelPath`, then verify end-to-end through the sidecar: spawn it against the downloaded model, embed a probe text, and assert the vector dimension is 384. On success, it SHALL write `embedding.mode = "local"` and `embedding.modelPath` to config. Neither download SHALL occur if the user declines. Verification through the sidecar SHALL be the same in the compiled binary and from source.

#### Scenario: User opts into local embeddings

- **WHEN** the user is prompted "Use local embeddings?" and selects yes
- **THEN** the sidecar runtime SHALL be materialized and the GGUF model SHALL be downloaded to `env.embeddingModelPath`
- **AND** the sidecar SHALL serve a probe embedding whose dimension is verified as 384
- **AND** config SHALL be updated with `embedding.mode = "local"` and `embedding.modelPath`

#### Scenario: User declines local embeddings

- **WHEN** the user is prompted "Use local embeddings?" and selects no
- **THEN** no model SHALL be downloaded and no runtime SHALL be materialized
- **AND** config SHALL remain `embedding.mode = "off"` (or prompt for api-key)

#### Scenario: Model already present is not re-downloaded

- **WHEN** the user opts into local embeddings and `env.embeddingModelPath` already exists
- **THEN** the download SHALL be skipped
- **AND** verification (sidecar probe) SHALL still run

#### Scenario: Verification fails

- **WHEN** the sidecar cannot serve a valid 384-dim probe embedding for the downloaded model
- **THEN** setup SHALL report the error and leave `embedding.mode` unchanged (not "local")

### Requirement: Embedder readiness gate for the hot path

`ensureEmbedderReady()` in `src/modules/embedding/setup.ts` SHALL mirror `ensureProxyReady()`: for `mode === "local"`, it SHALL check that the GGUF model file exists and that the pinned sidecar runtime is materialized or materializable, returning `Result<void, EmbeddingSetupError>`. It SHALL NOT spawn the sidecar or re-verify the model on every call — file/dir existence checks are sufficient for the hot path. A missing model file SHALL direct the user to `inflexa setup --embeddings local` — which succeeds in every install context.

#### Scenario: Model present and runtime materialized

- **WHEN** `ensureEmbedderReady()` is called, `env.embeddingModelPath` exists, and the runtime directory is materialized
- **THEN** it SHALL return `ok(undefined)` without spawning the sidecar

#### Scenario: Model missing

- **WHEN** `ensureEmbedderReady()` is called and `env.embeddingModelPath` does not exist
- **THEN** it SHALL return `err` with a message directing the user to run `inflexa setup --embeddings local`

### Requirement: Embedding setup is wired into the interactive setup flow

The interactive `inflexa setup` questionnaire SHALL include an embedding-mode question after provider auth, offering the same three modes (`local`, `api-key`, `off`) in every install context — local mode works identically in the compiled binary and from source, so no context gates the offering. The question SHALL be skippable (defaulting to `off`). Non-interactive shells (no TTY) SHALL skip the embedding question without hanging, leaving `mode` unchanged.

#### Scenario: Interactive setup asks about embeddings

- **WHEN** `inflexa setup` runs in a TTY (compiled binary or source checkout)
- **THEN** the user SHALL be prompted to choose an embedding mode after provider auth, with `local` selectable

#### Scenario: Non-interactive setup skips embeddings

- **WHEN** `inflexa setup` runs without a TTY
- **THEN** the embedding question SHALL be skipped

## REMOVED Requirements

### Requirement: node-llama-cpp is an optional, lazily-fetched dependency

**Reason**: The dependency is eliminated. The sidecar realization removes `node-llama-cpp` from `package.json` (`optionalDependencies` and `trustedDependencies`) entirely, along with the `bun pm trust` step and the postinstall-blocking accommodations — the product no longer depends on a `bun` binary on PATH for any embedding path.
**Migration**: Native inference is provided by the pinned `llama-server` runtime per the "Sidecar runtime acquisition" requirement; source checkouts get it via the same materialization step (downloaded) that compiled binaries use (embedded).
