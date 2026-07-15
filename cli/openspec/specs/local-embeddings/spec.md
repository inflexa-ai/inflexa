## Purpose

Local text embeddings for the cli via a pinned `llama.cpp` `llama-server` sidecar — a bge-small GGUF served over loopback with a per-spawn API key — realizing the harness `EmbeddingProvider` seam; the mode-based `embedding` config key that selects between it, a direct OpenAI-compatible endpoint, and off; and the setup flow that materializes the runtime, downloads and verifies the model, and records the choice. The realization is identical in the compiled binary and from source.
## Requirements
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

### Requirement: Embedding vectors are 384-dimensional and L2-normalized

Every vector returned by `createLocalEmbeddingProvider.embed()` SHALL have exactly 384 dimensions and SHALL be L2-normalized (Euclidean norm within 0.001 of 1.0). The current realization delegates normalization to the sidecar: `llama-server` applies the model's pooling and L2 normalization server-side, and the provider passes vectors through unchanged. The unit-norm guarantee belongs to the provider's contract, not to the transport — any replacement transport that does not normalize server-side SHALL re-establish normalization client-side before returning vectors.

#### Scenario: Vector dimension is 384

- **WHEN** `embed(["some text"], session)` resolves to `ok(vectors)`
- **THEN** `vectors[0].length` SHALL equal 384

#### Scenario: Vectors are L2-normalized

- **WHEN** `embed(["some text"], session)` resolves to `ok(vectors)`
- **THEN** `Math.sqrt(vectors[0].reduce((s, v) => s + v*v, 0))` SHALL be within 0.001 of 1.0

#### Scenario: Empty input returns empty output

- **WHEN** `embed([], session)` is called
- **THEN** it SHALL resolve to `ok([])` without spawning the sidecar

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

### Requirement: Embedding model path is env-managed

`cli/src/lib/env.ts` SHALL expose `env.modelDir` (`<dataDir>/inflexa/models/`) and `env.embeddingModelPath` (`<modelDir>/bge-small-en-v1.5-q8_0.gguf`). These SHALL be included in `envDoc` for `--help` visibility.

#### Scenario: Model path resolves under the data dir

- **WHEN** `env.embeddingModelPath` is read
- **THEN** it SHALL be `<dataDir>/inflexa/models/bge-small-en-v1.5-q8_0.gguf`

#### Scenario: Model dir appears in help

- **WHEN** `inflexa --help` is run
- **THEN** the paths section SHALL list the models directory

### Requirement: Embedder readiness gate for the hot path

`ensureEmbedderReady()` in `src/modules/embedding/setup.ts` SHALL mirror `ensureProxyReady()`: for `mode === "local"`, it SHALL check that the GGUF model file exists and that the pinned sidecar runtime is materialized — and when the runtime is not yet materialized, the gate SHALL materialize it right there (self-healing, like the launch gate's container provisioning), so an offline failure surfaces at launch with an actionable error rather than mid-chat. It SHALL NOT spawn the sidecar or re-verify the model — beyond the one-time materialization, existence checks are all the hot path pays. A missing model file SHALL direct the user to `inflexa setup --embeddings local` — which succeeds in every install context.

#### Scenario: Model present and runtime materialized

- **WHEN** `ensureEmbedderReady()` is called, `env.embeddingModelPath` exists, and the runtime directory is materialized
- **THEN** it SHALL return `ok(undefined)` without spawning the sidecar or doing acquisition work

#### Scenario: Runtime not yet materialized is healed at the gate

- **WHEN** `ensureEmbedderReady()` is called with the model present but the runtime directory absent
- **THEN** the gate materializes the runtime (embedded asset or pinned download) and returns `ok(undefined)`
- **AND** a materialization failure (e.g. offline source checkout) returns `err` with actionable remediation instead of deferring the failure to mid-chat

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

### Requirement: Sidecar runtime acquisition is pinned, verified, and atomic

The local embedding runtime SHALL be an official prebuilt `llama.cpp` release archive (containing `llama-server` and its companion shared libraries), pinned to an exact release tag per platform with SHA-256 checksums vendored in this repository — upstream publishes none, so the vendored hash is the sole integrity authority. The macOS arm64 pin SHALL be a build compatible with the product's supported macOS versions (current upstream macOS builds require macOS 26). Acquisition SHALL be source-aware: the compiled binary carries its own platform's archive as a build-time embedded asset (each target embeds exactly one); a source checkout downloads the identical pinned artifact. Both sources SHALL converge on one materialization step: verify the SHA-256, extract the complete archive directory (the server resolves its shared libraries relative to itself), and atomically rename into a tag-named directory under the data dir — a partial or failed materialization SHALL leave no trace at the final path, and re-running SHALL converge (an already-materialized tag directory is reused without network or extraction). The build SHALL remove cached archives that match no current pin before compiling, so a stale embed reference fails the build loudly rather than embedding a superseded runtime.

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

#### Scenario: Stale cached artifact cannot be embedded

- **WHEN** the vendored pins change and a build runs while the local build cache still holds an archive for the superseded tag
- **THEN** the stale archive is removed before compilation, and an embed reference that still names it fails the build rather than embedding the superseded runtime

### Requirement: Sidecar lifecycle is lazy, loopback-only, and reaped

The provider SHALL spawn `llama-server` lazily on first `embed()` (a process that never embeds never spawns it), bind it to `127.0.0.1` on an ephemerally allocated free port, and protect it with a per-spawn minted API key delivered through the child process's environment — never through argv, where it would be readable in the host's process listing. Readiness SHALL require two gates: the server's public health endpoint reporting the model loaded, then one authenticated request to a key-gated endpoint succeeding with the minted key — the health endpoint is unauthenticated upstream, so only the second gate proves the server on this port holds our key (and proves key delivery end-to-end at launch: an auth rejection of our own key fails the launch with an actionable error rather than surfacing at first embed). Launch SHALL observe the child's exit: a child that exits before becoming healthy fails that launch attempt immediately (the health timeout is a bound, not a sentence), and a sidecar that exits after becoming ready SHALL invalidate the cached readiness so the next `embed()` spawns a fresh one — a mid-session crash costs one failed batch, never the rest of the process lifetime. The child's stderr SHALL be continuously drained into a bounded tail (an undrained pipe would eventually block the server), and launch failures SHALL include that tail so the server's own diagnostics reach the user. Before any sidecar traffic flows, the proxy bypass SHALL compute the union of existing entries across both `NO_PROXY` spellings, add the loopback hosts, and write the same union to both spellings — a user's proxy-bypass entry present in only one spelling SHALL never be shadowed. Embedding requests SHALL guard the model's 512-token per-input ceiling client-side (truncate or chunk before sending) — an over-length input must never surface as a raw server error.

#### Scenario: Lazy spawn and reuse

- **WHEN** `embed()` is called for the first time
- **THEN** the sidecar is spawned, health-checked, and used — and subsequent `embed()` calls in the same process reuse it without a new spawn

#### Scenario: No embed, no sidecar

- **WHEN** a CLI process never calls `embed()`
- **THEN** no sidecar process is ever spawned

#### Scenario: Key is not visible in the process listing

- **WHEN** the sidecar is running
- **THEN** the minted API key appears in the child's environment, not in its command line

#### Scenario: Readiness requires the key to be honored

- **WHEN** a server on the sidecar's port answers the public health probe but rejects the minted key on the authenticated gate
- **THEN** the launch fails with an error naming the authentication mismatch — it is never declared ready

#### Scenario: Early exit fails fast with diagnostics

- **WHEN** the spawned server exits before answering the health probe (port already bound, unloadable model)
- **THEN** that launch attempt fails as soon as the exit is observed — not after the full readiness timeout — and the failure includes the server's stderr tail

#### Scenario: Crash after readiness triggers respawn

- **WHEN** the sidecar exits after having served embeddings and `embed()` is called again
- **THEN** the cached readiness is invalidated and a fresh sidecar is spawned for the new request

#### Scenario: Single-spelling proxy bypass is preserved

- **WHEN** the user has proxy-bypass entries in only one of `NO_PROXY`/`no_proxy` and the sidecar launches
- **THEN** both spellings end up carrying the union of the user's entries plus loopback, and no previously honored entry is dropped from either

#### Scenario: Over-length input is guarded

- **WHEN** an input longer than the model's 512-token ceiling is embedded
- **THEN** the provider truncates or chunks it client-side and returns a valid embedding, never a raw server error

### Requirement: Sidecar termination is escalated and signal-covered

Terminating the sidecar SHALL send SIGTERM and escalate to SIGKILL when the process has not exited within a short grace period, so a wedged server cannot survive its own reap. The reap SHALL run on every non-crash CLI exit, including signal-initiated ones: SIGTERM and SIGHUP of the CLI process SHALL run the same shutdown chain as a normal exit before terminating. A stop that races an in-flight launch SHALL still result in the spawned process being reaped — the losing launch detects it was superseded when it resolves, terminates its own process, and caches nothing.

#### Scenario: Shutdown reaps the sidecar

- **WHEN** the CLI process exits normally
- **THEN** the sidecar receives SIGTERM and does not outlive the CLI

#### Scenario: Signal-terminated CLI still reaps

- **WHEN** the CLI process receives SIGTERM or SIGHUP while the sidecar is running
- **THEN** the shutdown chain runs and the sidecar does not outlive the CLI

#### Scenario: Wedged sidecar is force-killed

- **WHEN** the sidecar ignores SIGTERM past the grace period during a reap
- **THEN** it is SIGKILLed rather than left running

#### Scenario: Stop racing an in-flight launch leaks nothing

- **WHEN** the sidecar is stopped while its first launch is still in progress
- **THEN** the launched process is terminated when the launch resolves, and no stale readiness is cached

