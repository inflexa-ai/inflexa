## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Embedding setup downloads and verifies the model on opt-in

`inflexa setup` SHALL ask the user whether to use local embeddings. If yes, it SHALL ensure the sidecar runtime is materialized (per the acquisition requirement) and acquire `bge-small-en-v1.5-q8_0.gguf` (~36 MB) to `env.embeddingModelPath` source-aware, mirroring runtime acquisition: the compiled binary SHALL copy the model from its build-time embedded asset with no network access; a source checkout SHALL download the pinned revision from `CompendiumLabs/bge-small-en-v1.5-gguf` on HuggingFace. Both sources SHALL be verified against the vendored SHA-256 before any bytes land at `env.embeddingModelPath` — staged beside the final path and atomically renamed, so a partial or failed acquisition leaves nothing there — then verified end-to-end through the sidecar: spawn it against the acquired model, embed a probe text, and assert the vector dimension is 384. On success, it SHALL write `embedding.mode = "local"` and `embedding.modelPath` to config. No acquisition SHALL occur if the user declines. Verification through the sidecar SHALL be the same in the compiled binary and from source. User-facing setup copy SHALL match the install context — the compiled binary SHALL NOT claim it downloads the model.

#### Scenario: User opts into local embeddings in the compiled binary

- **WHEN** the user opts into local embeddings in the compiled binary
- **THEN** the model SHALL be copied from the embedded asset to `env.embeddingModelPath` with no network access
- **AND** verified against the vendored SHA-256 before landing at the final path
- **AND** the sidecar SHALL serve a probe embedding whose dimension is verified as 384
- **AND** config SHALL be updated with `embedding.mode = "local"` and `embedding.modelPath`

#### Scenario: User opts into local embeddings in a source checkout

- **WHEN** the user opts into local embeddings in a source checkout
- **THEN** the pinned model revision SHALL be downloaded from HuggingFace, verified against the vendored SHA-256, and landed at `env.embeddingModelPath`
- **AND** the sidecar SHALL serve a probe embedding whose dimension is verified as 384
- **AND** config SHALL be updated with `embedding.mode = "local"` and `embedding.modelPath`

#### Scenario: User declines local embeddings

- **WHEN** the user is prompted "Use local embeddings?" and selects no
- **THEN** no model SHALL be acquired and no runtime SHALL be materialized
- **AND** config SHALL remain `embedding.mode = "off"` (or prompt for api-key)

#### Scenario: Model already present is not re-downloaded

- **WHEN** the user opts into local embeddings and `env.embeddingModelPath` already exists
- **THEN** acquisition SHALL be skipped (no download, no embedded-asset copy)
- **AND** verification (sidecar probe) SHALL still run

#### Scenario: Checksum mismatch leaves nothing at the final path

- **WHEN** the acquired bytes (from either source) fail SHA-256 verification
- **THEN** setup SHALL report an actionable error and nothing SHALL be left at `env.embeddingModelPath`

#### Scenario: Verification fails

- **WHEN** the sidecar cannot serve a valid 384-dim probe embedding for the acquired model
- **THEN** setup SHALL report the error and leave `embedding.mode` unchanged (not "local")

### Requirement: Embedding setup is wired into the interactive setup flow

The interactive `inflexa setup` questionnaire SHALL include an embedding-mode question after provider auth, offering the same three modes (`local`, `api-key`, `off`) in every install context — local mode works identically in the compiled binary and from source, so no context gates the offering. The question SHALL be skippable (defaulting to `off`). Non-interactive shells (no TTY) SHALL skip the embedding question without hanging, leaving `mode` unchanged.

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
