## ADDED Requirements

### Requirement: Stage an analysis's inputs into the session tree

The system SHALL provide `stageInputs(analysisId, targetDir)` in
`src/modules/staging/staging.ts` returning `Result`-typed `StagedInput[]`, where
`targetDir` is the analysis's session-tree `data/` root
(`{sessionsBasePath}/{analysisId}/data`). Each staged file SHALL be placed at
`{targetDir}/inputs/local/{key}` and described by a manifest entry
`{fileId, mountName: "local", key, fileName, hash, size, relativePath}` whose
`relativePath` is `inputs/local/{key}` — field-for-field compatible with the harness
`StagedInput` contract, passed to the harness verbatim with no transform. Directory
inputs SHALL be walked into one entry per contained file, with `key` preserving the
input's relative structure. Anchored inputs use their anchor-relative path as the
key; anchorless inputs (absolute host paths) SHALL use `{fileId}/{basename}` instead
— the host filesystem layout must never leak into the sandbox tree or the manifest,
and keys MUST equal the staged file's path relative to `inputs/local` exactly.

#### Scenario: Anchorless input keys carry no host path

- **WHEN** an input stored as an absolute path (no anchor) is staged
- **THEN** its key is `{fileId}/{basename}`, the file exists at `inputs/local/{key}`, and no host directory segment appears in the manifest

#### Scenario: Single-file input staged at the contract path

- **WHEN** `stageInputs` runs for an analysis with one resolvable single-file input
- **THEN** the file's bytes are readable at `{targetDir}/inputs/local/{key}`
- **AND** the returned manifest has one entry with `relativePath = "inputs/local/{key}"`, the file's content hash, and its size

#### Scenario: Directory input becomes per-file entries

- **WHEN** an input resolves to a directory containing nested files
- **THEN** every contained file is staged under `{targetDir}/inputs/local/` preserving its relative subpath
- **AND** the manifest contains one entry per file, none for directories

#### Scenario: Unresolvable inputs are skipped, staging continues

- **WHEN** one input's anchor cannot be resolved and another input is resolvable
- **THEN** the unresolvable input is omitted from the manifest
- **AND** the resolvable input is staged normally (partial staging over total failure)

#### Scenario: Staging I/O errors fail the whole operation

- **WHEN** copying or linking a resolvable input fails with a filesystem error
- **THEN** `stageInputs` returns the error variant rather than a partial manifest

### Requirement: Hardlink-first materialization

Staging SHALL attempt a hardlink first and fall back to a byte copy when linking fails
(e.g. cross-filesystem). Staging SHALL NOT create symlinks: the session tree is
bind-mounted into sandbox containers, where host symlinks dangle.

#### Scenario: Cross-filesystem fallback

- **WHEN** the input file lives on a different filesystem than the session tree
- **THEN** the file is staged as a full copy and the manifest entry is identical to the hardlink case

### Requirement: Symlinked files inside directory inputs are staged

When walking a directory input, entries that are symlinks SHALL be resolved via stat:
a symlink to a file is staged (as the target's content), and a symlink to a directory
is traversed. Symlinks whose target does not exist SHALL be skipped without failing
the walk.

#### Scenario: Symlink to a file within a directory input

- **WHEN** a directory input contains a symlink pointing at a regular file
- **THEN** the target's content is staged and appears in the manifest

#### Scenario: Dangling symlink is skipped

- **WHEN** a directory input contains a symlink whose target no longer exists
- **THEN** the walk completes without error and no manifest entry is produced for it

### Requirement: Noise directories are never staged

Directory-input walks SHALL skip directories whose name identifies tool or
source-control noise rather than data: the harness's ignored set (`node_modules`,
`__pycache__`, `.cache`, `.ruff_cache`, `.ipynb_checkpoints`, `.Rproj.user`) plus the
cli-specific `.git` and `.inflexa` (the anchor-marker directory). Skipping SHALL apply
to the whole subtree, including directories reached through symlinks.

#### Scenario: Project root selected as a directory input

- **WHEN** a directory input contains `node_modules/`, `.git/`, and a data file
- **THEN** only the data file is staged and the noise directories appear neither in the manifest nor on disk

### Requirement: The staged tree mirrors the current inputs

`stageInputs` SHALL reconcile the `inputs/local` tree against the manifest it just
produced: staged files no current input produced SHALL be deleted, and directories
emptied by those deletions SHALL be pruned. Reconciliation happens at staging time —
not at input-removal time — because the expected manifest only exists here, removal
of the database row leaves nothing to key file cleanup on, and removal-time deletion
could race a run holding the tree in a read-only mount.

#### Scenario: Removed input's files disappear on the next staging

- **WHEN** an input is removed from the analysis and `stageInputs` runs again
- **THEN** that input's staged files are deleted, its emptied directories pruned, and the remaining inputs' files untouched

#### Scenario: Newly ignored subtrees are cleaned up

- **WHEN** the staged tree contains files under a directory name the walk now ignores
- **THEN** the next staging deletes them even though the staging walk itself skips that name

### Requirement: Deterministic file identity

`fileId` SHALL be derived deterministically from the input's identity (anchor id plus
input path, plus the relative subpath for files inside directory inputs), so re-staging
the same input yields the same `fileId` across runs. The derivation for directory
members (subpath included) SHALL be documented where it diverges from single-file
derivation.

#### Scenario: Re-staging yields stable identities

- **WHEN** the same analysis is staged twice with unchanged inputs
- **THEN** every file receives the same `fileId` in both manifests
