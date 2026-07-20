## Purpose

Local text embeddings for the cli via a pinned `llama.cpp` `llama-server` sidecar — a GGUF served over loopback with a per-spawn API key — realizing the harness `EmbeddingProvider` seam; the mode-based `embedding` config key that selects between it, a direct OpenAI-compatible endpoint, and off; the setup flow whose picker offers the built-in bge-small model, the user's own local GGUF, an api-key endpoint, or off, and materializes/verifies/records the choice; and `inflexa config`, which reconfigures the backend through a picker plus per-backend follow-up dialogs. The realization is identical in the compiled binary and from source.
## Requirements
### Requirement: Local embedding provider realizes the harness EmbeddingProvider seam

The CLI SHALL provide `createLocalEmbeddingProvider(deps): EmbeddingProvider` from `src/modules/embedding/local-provider.ts`, where `EmbeddingProvider` is the harness interface (`embed(texts, session) → ResultAsync<number[][], ProviderError>`). The provider SHALL run the GGUF at `deps.modelPath` (the built-in `bge-small-en-v1.5` q8_0, or a user's own model) via the pinned `llama-server` sidecar and SHALL transport embeddings through the harness's existing OpenAI-shaped embedding provider pointed at the sidecar's loopback endpoint — no bespoke wire client. The advertised width SHALL be `deps.dimensions` when set (a custom GGUF's width, measured at setup), else the built-in default of 384; that ONE value SHALL drive both the sidecar request width and the `provider.dimensions` the harness sizes each index to, so the two can never disagree. The realization SHALL be identical in the compiled binary and in a source checkout. Failures (runtime not materializable, sidecar failed to start or become healthy) SHALL be returned as `err(ProviderError)` with actionable remediation — never thrown.

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

### Requirement: Embedding vectors match the advertised width and are L2-normalized

Every vector returned by `createLocalEmbeddingProvider.embed()` SHALL have exactly the provider's advertised `dimensions` (384 for the built-in `bge-small-en-v1.5`; a custom GGUF's own width, measured and recorded at setup) and SHALL be L2-normalized (Euclidean norm within 0.001 of 1.0). The current realization delegates normalization to the sidecar: `llama-server` applies the model's pooling and L2 normalization server-side, and the provider passes vectors through unchanged. The unit-norm guarantee belongs to the provider's contract, not to the transport — any replacement transport that does not normalize server-side SHALL re-establish normalization client-side before returning vectors.

#### Scenario: Vector dimension matches the advertised width

- **WHEN** `embed(["some text"], session)` resolves to `ok(vectors)`
- **THEN** `vectors[0].length` SHALL equal the provider's advertised `dimensions` (384 for the built-in model)

#### Scenario: Vectors are L2-normalized

- **WHEN** `embed(["some text"], session)` resolves to `ok(vectors)`
- **THEN** `Math.sqrt(vectors[0].reduce((s, v) => s + v*v, 0))` SHALL be within 0.001 of 1.0

#### Scenario: Empty input returns empty output

- **WHEN** `embed([], session)` is called
- **THEN** it SHALL resolve to `ok([])` without spawning the sidecar

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

- **WHEN** setup is asked to select an embedding mode while `embedding.mode` is already a different non-`off` mode
- **THEN** it SHALL warn loudly that existing analyses' search indexes keep the previous backend's vector width and fail for search and further indexing until re-profiled (automatic re-embedding is deliberately unsupported for now)

### Requirement: Embedding setup offers the built-in model, a custom GGUF, or api-key

`inflexa setup` SHALL let the user pick an embedding backend via a `select` picker offering four choices: the BUILT-IN model, the user's OWN local GGUF (a path they supply), an API-key endpoint, or off. Picker copy SHALL match the install context — the built-in choice SHALL NOT claim it downloads the model in a compiled binary, where it is an embedded asset.

For the BUILT-IN model, setup SHALL materialize the sidecar runtime (per the acquisition requirement) and acquire `bge-small-en-v1.5-q8_0.gguf` (~36 MB) to `env.embeddingModelPath` source-aware, mirroring runtime acquisition: the compiled binary SHALL copy the model from its build-time embedded asset with no network access; a source checkout SHALL download the pinned revision from `CompendiumLabs/bge-small-en-v1.5-gguf` on HuggingFace. Both sources SHALL be verified against the vendored SHA-256 before any bytes land at `env.embeddingModelPath` — staged beside the final path and atomically renamed — then verified end-to-end through the sidecar, ASSERTING the vector dimension is 384 (the model is SHA-256-pinned, so any other width means a corrupt asset). On success it SHALL write `embedding.mode = "local"` and `embedding.modelPath = env.embeddingModelPath` (no `dimensions` — the provider defaults to 384).

For a CUSTOM GGUF, setup SHALL prompt for a file path, confirm the file exists, materialize the runtime, and verify through the sidecar WITHOUT asserting a fixed width — MEASURING whatever width the model emits. It SHALL NOT acquire anything: the file is the user's, so nothing is copied or downloaded. On success it SHALL write `embedding.mode = "local"`, `embedding.modelPath = <the supplied path>`, and `embedding.dimensions = <the measured width>` when that differs from the built-in 384 (recording it so the harness sizes each index to what the model emits). A zero-width or failed probe SHALL leave `embedding.mode` unchanged.

For api-key or off, no model SHALL be acquired. A `--embeddings local|api-key|off` preselection SHALL select the backend non-interactively; `local` is the BUILT-IN model (a custom path requires the interactive path prompt, so it has no flag form). Verification through the sidecar SHALL be the same in the compiled binary and from source.

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

### Requirement: Embedding model path is env-managed

`cli/src/lib/env.ts` SHALL expose `env.modelDir` (`<dataDir>/inflexa/models/`) and `env.embeddingModelPath` (`<modelDir>/bge-small-en-v1.5-q8_0.gguf`). These SHALL be included in `envDoc` for `--help` visibility.

#### Scenario: Model path resolves under the data dir

- **WHEN** `env.embeddingModelPath` is read
- **THEN** it SHALL be `<dataDir>/inflexa/models/bge-small-en-v1.5-q8_0.gguf`

#### Scenario: Model dir appears in help

- **WHEN** `inflexa --help` is run
- **THEN** the paths section SHALL list the models directory

### Requirement: Embedder readiness gate for the hot path

`ensureEmbedderReady()` in `src/modules/embedding/setup.ts` SHALL mirror `ensureProxyReady()`: for `mode === "local"`, it SHALL check that the CONFIGURED GGUF model file exists and that the pinned sidecar runtime is materialized — and when the runtime is not yet materialized, the gate SHALL materialize it right there (self-healing, like the launch gate's container provisioning), so an offline failure surfaces at launch with an actionable error rather than mid-chat. The model file it checks SHALL be `embedding.modelPath` (falling back to `env.embeddingModelPath` only when none is recorded), so a custom GGUF at the user's own path passes the gate — checking the built-in location would spuriously fail it. It SHALL NOT spawn the sidecar or re-verify the model — beyond the one-time materialization, existence checks are all the hot path pays. A missing model file SHALL direct the user to `inflexa setup` (which succeeds in every install context) or to point `embedding.modelPath` at their GGUF.

#### Scenario: Model present and runtime materialized

- **WHEN** `ensureEmbedderReady()` is called, the configured model path exists, and the runtime directory is materialized
- **THEN** it SHALL return `ok(undefined)` without spawning the sidecar or doing acquisition work

#### Scenario: A custom model path is gated, not the built-in location

- **WHEN** `embedding.modelPath` points at a custom GGUF that exists while `env.embeddingModelPath` does NOT, and the runtime is materialized
- **THEN** the gate SHALL return `ok(undefined)` — it checks the configured path, never spuriously failing on the absent built-in location

#### Scenario: Runtime not yet materialized is healed at the gate

- **WHEN** `ensureEmbedderReady()` is called with the model present but the runtime directory absent
- **THEN** the gate materializes the runtime (embedded asset or pinned download) and returns `ok(undefined)`
- **AND** a materialization failure (e.g. offline source checkout) returns `err` with actionable remediation instead of deferring the failure to mid-chat

#### Scenario: Model missing

- **WHEN** `ensureEmbedderReady()` is called and the configured model path does not exist
- **THEN** it SHALL return `err` naming that path and directing the user to run `inflexa setup` or point `embedding.modelPath` at their GGUF

### Requirement: Embedding setup is wired into the interactive setup flow

The interactive `inflexa setup` questionnaire SHALL include an embedding-backend question after provider auth, offering four choices (the built-in model, a path to the user's own GGUF, `api-key`, `off`) in every install context — local mode works identically in the compiled binary and from source, so no context gates the offering. The question SHALL be skippable (defaulting to `off`). Non-interactive shells (no TTY) SHALL skip the embedding question without hanging, leaving `mode` unchanged.

When `inflexa setup` is invoked with an explicit `--embeddings local|api-key|off` preselection, the embedding step SHALL run before the container-runtime probe, so an environment without a ready Docker/Podman can still configure embeddings non-interactively. This reorder applies ONLY to an explicit preselection: the interactive question's position is unchanged (still after provider auth). The remainder of setup still requires a ready runtime and SHALL still fail afterward when none is available — the preselected embeddings are already durably configured by then. The embedding step SHALL NOT run twice in one setup invocation: when the preselected pre-gate step has already run, the in-flow embedding step SHALL be skipped.

#### Scenario: Interactive setup asks about embeddings

- **WHEN** `inflexa setup` runs in a TTY (compiled binary or source checkout)
- **THEN** the user SHALL be prompted to choose an embedding mode after provider auth, with `local` selectable

#### Scenario: Non-interactive setup skips embeddings

- **WHEN** `inflexa setup` runs without a TTY
- **THEN** the embedding question SHALL be skipped

#### Scenario: Preselected embeddings configure without a container runtime

- **WHEN** `inflexa setup --embeddings local` runs with no ready Docker or Podman
- **THEN** the embedding step SHALL run before the container-runtime probe — the model is acquired, verified, and configured (`embedding.mode = "local"`)
- **AND** the missing-runtime error SHALL still be reported for the remainder of setup

#### Scenario: Preselected embeddings run once

- **WHEN** a preselected mode is given and a container runtime IS ready
- **THEN** the embedding step SHALL run exactly once — the pre-gate preselected step runs and the in-flow embedding step is skipped

### Requirement: Embedding settings are configured through dialogs in `inflexa config`

The `inflexa config` settings screen SHALL present the embedding configuration as a SINGLE summary row naming the active backend and its distinguishing detail (the built-in model, the custom GGUF's file name, or the api-key model) — NOT as a set of always-visible per-field rows. `embedding.*` is a mode-discriminated union, so the fields belonging to an inactive backend are noise the screen SHALL NOT render. Activating the row SHALL open a backend picker dialog offering four choices — the built-in model, the user's own GGUF, an api-key endpoint, or off — and the chosen backend SHALL determine which follow-up dialogs collect its data. Every dialog SHALL be an existing dialog-system component (`SelectDialog`, `PromptDialog`, `FilePicker`) chained by selection rather than a new bespoke form; cancelling any step SHALL abort the whole change, leaving `config.json` untouched.

Data collection per backend:

- **Built-in model** and **off** SHALL require no follow-up input and apply immediately.
- **The user's own GGUF** SHALL collect the model file path (a file picker) and then its vector width. The width is ENTERED, not measured: this screen SHALL NOT spawn the sidecar — only `inflexa setup` probes a model — so a mistyped width is possible and is deliberately not guarded here.
- **api-key** SHALL collect the key and the base URL, then FETCH the endpoint's model listing (`{baseURL}/models`, narrowed to embedding-capable ids) and present the result as a SELECTION rather than free text. A failed, empty, or unusable fetch SHALL fall back to free-text model entry so the flow never dead-ends. The vector width SHALL be collected separately, because the model listing does not carry it.

Editing SHALL write `config.json` only — it SHALL NOT acquire, download, or verify a model (that remains `inflexa setup`'s job); correctness is enforced at the next run by the readiness gate and the profile dimension probe, exactly as for a hand-edited config. The api key SHALL NOT be printed on the summary row (a remote secret), though its own edit prompt MAY show it.

#### Scenario: The screen shows one embedding row, not per-field rows

- **WHEN** the user opens `inflexa config`
- **THEN** exactly one embedding row SHALL be rendered, summarizing the active backend
- **AND** no field belonging to an inactive backend SHALL be rendered

#### Scenario: Choosing the built-in model applies without further input

- **WHEN** the user activates the embedding row and picks the built-in model
- **THEN** config SHALL be set to `mode = "local"` with the built-in model path, with no further prompts

#### Scenario: Choosing your own GGUF collects a path then a width

- **WHEN** the user picks "your own GGUF"
- **THEN** a file picker SHALL collect the model path and a prompt SHALL collect its vector width
- **AND** config SHALL be set to `mode = "local"` with that path and width, with no model spawned or probed

#### Scenario: Choosing api-key fetches the endpoint's models as a selection

- **WHEN** the user picks api-key and supplies a key and base URL
- **THEN** the endpoint's embedding-capable models SHALL be fetched and offered as a selection
- **AND** the vector width SHALL be collected separately

#### Scenario: A failed model fetch falls back to free-text entry

- **WHEN** the model fetch fails, returns nothing, or yields no embedding-capable id
- **THEN** the flow SHALL fall back to free-text model entry rather than dead-ending

#### Scenario: Cancelling a dialog leaves config untouched

- **WHEN** the user cancels any dialog in the chain
- **THEN** no change SHALL be written to `config.json`

#### Scenario: Config edits do not acquire or verify a model

- **WHEN** the user completes a backend change in `inflexa config`
- **THEN** only `config.json` SHALL be written — no model is downloaded, copied, or probed; the readiness gate and profile probe enforce correctness at the next run

#### Scenario: The api key is not shown on the summary row

- **WHEN** `embedding.apiKey` is set and the embedding row is rendered
- **THEN** the row SHALL NOT display the key value

### Requirement: Embedding model is a build-time embedded asset

The release build SHALL download the pinned `bge-small-en-v1.5-q8_0.gguf` into the build artifact cache before compiling, verify it against the vendored SHA-256 (the sole integrity authority, shared with runtime verification — a cache hit SHALL be re-verified rather than trusted), and embed it into EVERY target binary. The model is platform-independent: one asset serves all targets with no per-target selection. A download or hash failure SHALL fail the build loudly; a binary SHALL never embed unverified or mismatched model bytes. The build's stale-artifact sweep SHALL keep the current model artifact while removing model files that match no current pin, so after a pin bump a stale embed reference fails the build rather than silently embedding the superseded model.

#### Scenario: Cold cache fetches, verifies, and embeds

- **WHEN** a release build runs with no cached model artifact
- **THEN** the pinned model is downloaded, verified against the vendored SHA-256, cached, and embedded into every target binary

#### Scenario: Cache hit is re-verified

- **WHEN** a release build runs with the model artifact already cached
- **THEN** the cached bytes are re-hashed against the vendored SHA-256 before being embedded
- **AND** a mismatch fails the build with direction to delete the cache

#### Scenario: Hash mismatch fails the build

- **WHEN** the downloaded model's SHA-256 does not match the vendored pin
- **THEN** the build fails loudly and no binary is produced with the mismatched bytes

#### Scenario: Superseded model artifact cannot be embedded

- **WHEN** the model pin changes and a build runs while the cache still holds the superseded model file
- **THEN** the stale file is removed before compilation, and an embed reference that still names it fails the build

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

The provider SHALL spawn `llama-server` lazily on first `embed()` (a process that never embeds never spawns it), bind it to `127.0.0.1` on an ephemerally allocated free port, and protect it with a per-spawn minted API key delivered through the child process's environment — never through argv, where it would be readable in the host's process listing. Readiness SHALL require two gates: the server's public health endpoint reporting the model loaded, then one authenticated request to a key-gated endpoint succeeding with the minted key — the health endpoint is unauthenticated upstream, so only the second gate proves the server on this port holds our key (and proves key delivery end-to-end at launch: an auth rejection of our own key fails the launch with an actionable error rather than surfacing at first embed). Every readiness request SHALL carry its own bounded timeout in addition to the shared deadline, so a half-open server that accepts connections but never answers cannot hold the launch past the advertised bound. Launch SHALL observe the child's exit: a child that exits before becoming healthy fails that launch attempt immediately (the health timeout is a bound, not a sentence), and a sidecar that exits after becoming ready SHALL invalidate the cached readiness so the next `embed()` spawns a fresh one — a mid-session crash costs one failed batch, never the rest of the process lifetime. The child's stderr SHALL be continuously drained into a bounded tail (an undrained pipe would eventually block the server); when a launch fails because the child exited, the drain's completion SHALL be awaited (the exit closes the pipe, so completion is prompt) before the tail is read, so the failure always includes the server's final diagnostics rather than racing them. Before any sidecar traffic flows, the proxy bypass SHALL compute the union of existing entries across both `NO_PROXY` spellings, add the loopback hosts, and write the same union to both spellings — a user's proxy-bypass entry present in only one spelling SHALL never be shadowed. Input-length guarding against the model's token ceiling is its own requirement (token-exact truncation) and runs against the ready sidecar.

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

#### Scenario: Half-open server cannot hang the launch

- **WHEN** a process on the sidecar's port accepts connections but never answers the readiness requests
- **THEN** each request times out individually and the launch fails at the shared deadline, not later

#### Scenario: Early exit fails fast with complete diagnostics

- **WHEN** the spawned server exits before answering the health probe (port already bound, unloadable model)
- **THEN** that launch attempt fails as soon as the exit is observed — not after the full readiness timeout — and the failure includes the server's complete final stderr tail, never a partially drained one

#### Scenario: Crash after readiness triggers respawn

- **WHEN** the sidecar exits after having served embeddings and `embed()` is called again
- **THEN** the cached readiness is invalidated and a fresh sidecar is spawned for the new request

#### Scenario: Single-spelling proxy bypass is preserved

- **WHEN** the user has proxy-bypass entries in only one of `NO_PROXY`/`no_proxy` and the sidecar launches
- **THEN** both spellings end up carrying the union of the user's entries plus loopback, and no previously honored entry is dropped from either

### Requirement: Input truncation is token-exact and guaranteed under the model's ceiling

The provider SHALL bound every input under the model's 512-token per-input ceiling before it reaches the embeddings endpoint, budgeting 510 content tokens — the tokenizer wraps content in a `[CLS]`/`[SEP]` pair that consumes the remaining two positions. The bound SHALL be exact, not probabilistic: an input the guard passes SHALL never be rejected by the server as over-length. Token counts SHALL be measured with the ready sidecar's own `/tokenize` endpoint — the same process and tokenizer that serves the embed — at the server root (not under `/v1`), sending the minted API key, with a bounded per-request timeout, counting content tokens only (no special tokens; the budget already reserves the pair).

An input of at most 510 UTF-16 code units SHALL pass unchanged with no measurement round-trip — a WordPiece token consumes at least one code unit, so its token count cannot exceed its length. A longer input SHALL first be measured whole and pass unchanged when it fits the budget. An input measuring over budget SHALL be truncated keeping the head, cut proportionally to its measured chars-per-token density with the cut backed off to a word boundary when one sits near it, and every candidate SHALL be re-measured before use, within a bounded number of measurement rounds. When the rounds are exhausted, or when any `/tokenize` interaction fails (error, timeout, malformed body), the provider SHALL fall back to a hard cut at 510 code units — which provably fits without a tokenizer — so measurement can never fail an embed. Tokenize interaction SHALL flow as `Result` values per the CLI's error discipline; a measurement failure selects the fallback rather than propagating into the embed's error channel.

#### Scenario: Short input skips measurement

- **WHEN** an input of at most 510 UTF-16 code units is embedded
- **THEN** it is embedded unchanged and no `/tokenize` request is made

#### Scenario: Long input that fits is embedded whole

- **WHEN** an input longer than 510 code units measures at or under 510 content tokens
- **THEN** it is embedded unchanged — no character cap discards content that fits the token budget

#### Scenario: Over-length input is truncated to a verified fit

- **WHEN** an input measures over 510 content tokens
- **THEN** a head-keeping, word-boundary-backed prefix whose re-measured token count is at or under 510 is embedded, and the server never rejects it as over-length

#### Scenario: Measurement failure degrades to the provable bound

- **WHEN** a `/tokenize` request fails or the bounded truncation rounds are exhausted
- **THEN** the provider embeds the input hard-cut at 510 code units and returns a valid embedding — the embed does not fail because measuring failed

### Requirement: Sidecar termination is escalated and signal-covered

Terminating the sidecar SHALL send SIGTERM and escalate to SIGKILL when the process has not exited within a short grace period, so a wedged server cannot survive its own reap; the terminate primitive SHALL be idempotent (repeated calls send one SIGTERM and arm one escalation timer). A live child SHALL be reachable by the reap from the moment it is spawned: the spawn handle is tracked before readiness resolves and the reap hook is registered before the first launch begins, so a shutdown landing mid-launch terminates the in-flight child rather than finding nothing. The reap SHALL run on every non-crash CLI exit, including signal-initiated ones: the first SIGTERM or SIGHUP runs the same shutdown chain as a normal exit before terminating, and a second signal while that chain is in flight SHALL force immediate exit — a hung shutdown hook must never make the process unkillable short of SIGKILL. A stop that races an in-flight launch SHALL still result in the spawned process being reaped. Exits the process cannot intercept (SIGKILL, a crash) SHALL be healed by the next spawn anywhere on the machine: before spawning, the provider SHALL kill processes executing this installation's materialized `llama-server` binary that have been reparented to pid 1 — the orphan signature — and SHALL never touch a sidecar whose parent is a live process (another CLI's sidecar).

#### Scenario: Shutdown reaps the sidecar

- **WHEN** the CLI process exits normally
- **THEN** the sidecar receives SIGTERM and does not outlive the CLI

#### Scenario: Signal-terminated CLI still reaps

- **WHEN** the CLI process receives SIGTERM or SIGHUP while the sidecar is running
- **THEN** the shutdown chain runs and the sidecar does not outlive the CLI

#### Scenario: Shutdown during an in-flight launch reaps the child

- **WHEN** the shutdown chain runs while a sidecar launch is still awaiting readiness
- **THEN** the already-spawned child is terminated — the reap never depends on the launch having completed

#### Scenario: Second signal forces exit

- **WHEN** a second SIGTERM or SIGHUP arrives while the shutdown chain from the first is still running
- **THEN** the process exits immediately with the conventional signal exit code

#### Scenario: Wedged sidecar is force-killed

- **WHEN** the sidecar ignores SIGTERM past the grace period during a reap
- **THEN** it is SIGKILLed rather than left running

#### Scenario: Stop racing an in-flight launch leaks nothing

- **WHEN** the sidecar is stopped while its first launch is still in progress
- **THEN** the launched process is terminated when the launch resolves, and no stale readiness is cached

#### Scenario: Orphans from unsurvivable exits are swept at the next spawn

- **WHEN** a previous CLI process was killed without running its shutdown chain and its sidecar was reparented to pid 1, and any CLI later spawns a sidecar
- **THEN** the orphaned process is killed before the new spawn, while a sidecar parented to a different live CLI is left untouched

