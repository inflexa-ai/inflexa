# input-staging Delta

## MODIFIED Requirements

### Requirement: Stage an analysis's inputs into the session tree

The system SHALL provide `stageInputs(analysisId, targetDir)` in
`src/modules/staging/staging.ts` returning `Result`-typed `StagedInput[]`, where
`targetDir` is the analysis workspace's `data/` root
(`{workspaceRoot}/data`, i.e. `<anchorPath>/.inflexa/analyses/<slug>/data` — resolved
via the same rule as every other workspace path; the deleted session-tree helpers
`sessionTreeRoot`/`sessionTreeDataDir` have no successor module, callers derive from
the workspace root). Each staged file SHALL be placed at
`{targetDir}/inputs/local/{key}` and described by a manifest entry
`{fileId, mountName: "local", key, fileName, hash, size, mtimeMs, relativePath}` whose
`relativePath` is `inputs/local/{key}` — field-for-field compatible with the harness
`StagedInput` contract, passed to the harness verbatim with no transform. Directory
inputs SHALL be walked into one entry per contained file, with `key` preserving the
input's relative structure. Anchored inputs use their anchor-relative path as the
key; anchorless inputs (absolute host paths) SHALL use `{fileId}/{basename}` instead
— the host filesystem layout must never leak into the sandbox tree or the manifest,
and keys MUST equal the staged file's path relative to `inputs/local` exactly.

`size` and `mtimeMs` SHALL be read from the same `stat` of the source file, so the manifest's drift
signature is consistent with the one `enumerateInputSignatures` produces for the same file.

#### Scenario: The manifest carries the drift signature

- **WHEN** `stageInputs` materializes an input file
- **THEN** its manifest element SHALL carry the source file's `size` in bytes and `mtimeMs` in epoch milliseconds

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
(e.g. cross-filesystem). With the workspace under the anchor, the hardlink path is the
common case — inputs usually share the anchor's filesystem. Staging SHALL NOT create
symlinks: the workspace tree is bind-mounted into sandbox containers, where host
symlinks dangle.

#### Scenario: Cross-filesystem fallback

- **WHEN** the input file lives on a different filesystem than the workspace tree
- **THEN** the file is staged as a full copy and the manifest entry is identical to the hardlink case

### Requirement: Noise directories are never staged

Directory-input walks SHALL skip directories whose name identifies tool or
source-control noise rather than data: the harness's ignored set (`node_modules`,
`__pycache__`, `.cache`, `.ruff_cache`, `.ipynb_checkpoints`, `.Rproj.user`) plus the
cli-specific `.git` and `.inflexa`. The `.inflexa` exclusion is load-bearing, not
hygiene: the workspace itself lives at `<anchor>/.inflexa/analyses/<slug>/`, so an
anchor-folder directory input would otherwise stage the analysis's own staged inputs
and run artifacts into itself, recursively. Skipping SHALL apply
to the whole subtree, including directories reached through symlinks.

#### Scenario: Project root selected as a directory input

- **WHEN** a directory input contains `node_modules/`, `.git/`, and a data file
- **THEN** only the data file is staged and the noise directories appear neither in the manifest nor on disk

#### Scenario: The anchor folder as an input never stages the workspace

- **GIVEN** an analysis whose input is its own anchor folder, after a completed run (the workspace holds `data/` and `runs/`)
- **WHEN** `stageInputs` runs again
- **THEN** nothing under `.inflexa/` is staged — the workspace does not ingest itself
