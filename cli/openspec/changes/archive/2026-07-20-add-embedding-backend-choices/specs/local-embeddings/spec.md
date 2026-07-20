## MODIFIED Requirements

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

## ADDED Requirements

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
