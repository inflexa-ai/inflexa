# local-embeddings Specification (delta)

## MODIFIED Requirements

### Requirement: Embedding setup offers the built-in model, a custom GGUF, or api-key

`inflexa setup` SHALL let the user pick an embedding backend via a `select` picker offering four choices: the BUILT-IN model, the user's OWN local GGUF (a path they supply), an API-key endpoint, or off. Picker copy SHALL match the install context — the built-in choice SHALL NOT claim it downloads the model in a compiled binary, where it is an embedded asset.

For the BUILT-IN model, setup SHALL materialize the sidecar runtime (per the acquisition requirement) and acquire `bge-small-en-v1.5-q8_0.gguf` (~36 MB) to `env.embeddingModelPath` source-aware, mirroring runtime acquisition: the compiled binary SHALL copy the model from its build-time embedded asset with no network access; a source checkout SHALL download the pinned revision from `CompendiumLabs/bge-small-en-v1.5-gguf` on HuggingFace. Both sources SHALL be verified against the vendored SHA-256 before any bytes land at `env.embeddingModelPath` — staged beside the final path and atomically renamed — then verified end-to-end through the sidecar, ASSERTING the vector dimension is 384 (the model is SHA-256-pinned, so any other width means a corrupt asset). On success it SHALL write `embedding.mode = "local"` and `embedding.modelPath = env.embeddingModelPath` (no `dimensions` — the provider defaults to 384).

For a CUSTOM GGUF, setup SHALL prompt for a file path, confirm the file exists, materialize the runtime, and verify through the sidecar WITHOUT asserting a fixed width — MEASURING whatever width the model emits. It SHALL NOT acquire anything: the file is the user's, so nothing is copied or downloaded. On success it SHALL write `embedding.mode = "local"`, `embedding.modelPath = <the supplied path>`, and `embedding.dimensions = <the measured width>` when that differs from the built-in 384 (recording it so the harness sizes each index to what the model emits). A zero-width or failed probe SHALL leave `embedding.mode` unchanged.

For api-key or off, no model SHALL be acquired. An embedding-mode answer (`--embeddings local|api-key|off`; file `embedding.mode`) SHALL select the backend non-interactively. An answered `off` SHALL persist `embedding.mode = "off"` — an answer declares desired state, so it disables a previously configured backend (model files on disk are untouched); this is distinct from the interactive picker's "Off / skip" choice, which continues to leave the mode unchanged. `local` with a GGUF answer (`--embeddings-gguf <path>`; file `embedding.gguf`) SHALL select the CUSTOM-GGUF branch non-interactively — the answer replaces the interactive path prompt, and the same exists-check, runtime materialization, and measured-width verification run; `local` without one is the BUILT-IN model. `api-key` SHALL take its endpoint and model as answers (`--embeddings-url`, `--embeddings-model`; file `embedding.baseURL`, `embedding.model`) with the secret from the `INFLEXA_EMBEDDING_API_KEY` environment variable — required under batch resolution, where the masked prompt cannot run; interactively, answered fields skip their prompts and the key prompt still runs when the variable is unset. Verification through the sidecar SHALL be the same in the compiled binary and from source.

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

### Requirement: Embedding setup is wired into the interactive setup flow

The interactive `inflexa setup` questionnaire SHALL include an embedding-backend question after provider auth, offering four choices (the built-in model, a path to the user's own GGUF, `api-key`, `off`) in every install context — local mode works identically in the compiled binary and from source, so no context gates the offering. The question SHALL be skippable (defaulting to `off`). Under batch resolution (`--yes` or non-TTY) with no embedding-mode answer, the question SHALL be skipped without hanging, leaving `mode` unchanged.

When an embedding-mode ANSWER is present — the `--embeddings` flag or the config file's `embedding.mode` — the embedding step SHALL run before the container-runtime probe, so an environment without a ready Docker/Podman can still configure embeddings non-interactively. This reorder applies ONLY to an answered mode: the interactive question's position is unchanged (still after provider auth). The remainder of setup still requires a ready runtime and SHALL still fail afterward when none is available — the answered embeddings are already durably configured by then. The embedding step SHALL NOT run twice in one setup invocation: when the answered pre-gate step has already run, the in-flow embedding step SHALL be skipped.

#### Scenario: Interactive setup asks about embeddings

- **WHEN** `inflexa setup` runs in a TTY (compiled binary or source checkout)
- **THEN** the user SHALL be prompted to choose an embedding mode after provider auth, with `local` selectable

#### Scenario: Batch setup without an embeddings answer skips the question

- **WHEN** setup runs under batch resolution with no embedding-mode answer
- **THEN** the embedding question SHALL be skipped and `mode` left unchanged

#### Scenario: Answered embeddings configure without a container runtime

- **WHEN** `inflexa setup --yes --embeddings local` runs with no ready Docker or Podman — or the same mode arrives via the config file
- **THEN** the embedding step SHALL run before the container-runtime probe — the model is acquired, verified, and configured (`embedding.mode = "local"`)
- **AND** the missing-runtime error SHALL still be reported for the remainder of setup

#### Scenario: Answered embeddings run once

- **WHEN** an embedding mode is answered and a container runtime IS ready
- **THEN** the embedding step SHALL run exactly once — the pre-gate answered step runs and the in-flow embedding step is skipped
