# input-staging — Delta

## MODIFIED Requirements

### Requirement: Identity-only input enumeration

The system SHALL provide `enumerateInputSignatures(analysisId)` in `src/modules/staging/` returning the
`Result`-typed set of **drift signatures** — `(fileId, size, mtimeMs)` — that `stageInputs` would
produce for the analysis's current inputs, using the same identity derivation and the same walk rules
(noise-directory skips, symlink handling, unresolvable inputs skipped, same-destination collision
resolved last-write-wins) — while writing nothing to the session tree, hashing no file content, and not
requiring the session tree to exist.

Its cost SHALL be bounded by directory enumeration plus one `stat` per file (never by input content
size), so parity drift checks can run on every chat open and every input mutation. The identity walk
SHALL be single-sourced with staging's walk: the two MUST NOT be able to drift on which files an input
yields.

The signature exists because `fileId` is derived from the input's anchor and path: two enumerations of
the same paths holding different bytes have identical `fileId` sets. Adding `size` and `mtimeMs` makes
an in-place content edit observable at stat cost. It SHALL NOT include a content hash — reading every
input in full on every chat open is the cost this enumeration exists to avoid. An edit that preserves
both byte length and mtime is consequently not detected; this is a bounded, accepted limitation.

#### Scenario: Enumeration matches staging's identity set

- **WHEN** `enumerateInputSignatures` and `stageInputs` run against the same inputs
- **THEN** every enumerated signature's `fileId` component equals exactly one staged manifest entry's `fileId`, and the two sets have the same size

#### Scenario: Enumeration performs no writes

- **WHEN** `enumerateInputSignatures` runs for an analysis whose session tree does not exist
- **THEN** it returns the signature set and creates no directory or file

#### Scenario: Enumeration hashes nothing

- **WHEN** `enumerateInputSignatures` runs over a large input file
- **THEN** the file's content SHALL NOT be read

#### Scenario: Unresolvable inputs are skipped consistently

- **WHEN** one input's anchor cannot be resolved
- **THEN** the enumeration omits it, exactly as staging's walk would

#### Scenario: An in-place edit changes the signature

- **WHEN** an input file's bytes are rewritten at the same path, changing its size or mtime
- **THEN** its enumerated signature SHALL differ from the one enumerated before the edit
- **AND** its `fileId` SHALL be unchanged

### Requirement: Stage an analysis's inputs into the session tree

`stageInputs(analysisId, targetDir)` SHALL resolve each of the analysis's inputs to an absolute path,
materialize the files it yields under `{targetDir}/inputs/local/{key}`, and return the `StagedInput[]`
manifest the harness consumes. Each manifest element SHALL carry the file's `fileId`, `mountName`,
`key`, `fileName`, content `hash`, `size`, `mtimeMs`, and `relativePath`, matching the harness's
`StagedInput` contract field-for-field so the manifest is wire-compatible without a transform.

`size` and `mtimeMs` SHALL be read from the same `stat` of the source file, so the manifest's drift
signature is consistent with the one `enumerateInputSignatures` produces for the same file.

Inputs that cannot be resolved to an absolute path SHALL be skipped with a warning rather than failing
the whole staging run.

#### Scenario: The manifest carries the drift signature

- **WHEN** `stageInputs` materializes an input file
- **THEN** its manifest element SHALL carry the source file's `size` in bytes and `mtimeMs` in epoch milliseconds

#### Scenario: An unresolvable input does not fail the run

- **WHEN** one input's anchor no longer resolves
- **THEN** staging SHALL skip it, log a warning, and return the manifest for the remaining inputs
