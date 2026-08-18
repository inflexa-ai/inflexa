## MODIFIED Requirements

### Requirement: Stage an analysis's inputs into the workspace tree

`stageInputs(analysisId, targetDir)` SHALL materialize every current input under
`{targetDir}/inputs/local/{key}` and return one manifest element per staged file in the
`StagedInput` contract, passed to the harness verbatim with no transform. Directory
inputs SHALL be walked into one entry per contained file, with `key` preserving the
input's relative structure. Anchored inputs use their anchor-relative path as the
key; anchorless inputs (absolute host paths) SHALL use `{fileId}/{basename}` instead
— the host filesystem layout must never leak into the sandbox tree or the manifest,
and keys MUST equal the staged file's path relative to `inputs/local` exactly.

`size` and `mtimeMs` SHALL be read from the same `stat` of the source file. They serve two
readers: the profile snapshot's recorded `inputSignature`, an audit record of what a profile
covered, and `isInputSetMaterialized`, which compares them against the staged copy to decide
whether the tree is current. They are no longer a drift comparand — a re-profile is invoked on
the input-mutation edge rather than derived from comparing them.

#### Scenario: The manifest carries size and mtime from one stat

- **WHEN** `stageInputs` materializes an input file
- **THEN** its manifest element SHALL carry the source file's `size` in bytes and `mtimeMs` in epoch milliseconds
- **AND** both SHALL come from the same `stat` call, taken before placement

#### Scenario: Anchorless input keys carry no host path

- **WHEN** an anchorless input at an absolute host path is staged
- **THEN** its `key` SHALL be `{fileId}/{basename}` and SHALL contain no directory component of the host path

### Requirement: Identity-only input enumeration

The system SHALL provide `enumerateInputPaths(analysisId)` in `src/modules/staging/` returning the
`Result`-typed set of **analysis-relative paths** that `stageInputs` would produce for the analysis's
current inputs, using the same identity derivation and the same walk rules (noise-directory skips,
symlink handling, unresolvable inputs skipped, same-destination collision resolved last-write-wins) —
while writing nothing to the workspace tree, hashing no file content, and not requiring the workspace
tree to exist.

Its cost SHALL be bounded by directory enumeration plus one `stat` per file (never by input content
size). The identity walk SHALL be single-sourced with staging's walk: the two MUST NOT be able to drift
on which files an input yields.

It SHALL carry no `size` or `mtimeMs`. Those existed to make an in-place content edit observable at stat
cost, for a drift comparison that no longer runs: a re-profile is invoked on the input-mutation edge, so
per-file drift signatures would be gathered on every chat open for no reader. The question this
enumeration answers is whether the analysis has inputs on disk right now — which is what the profile
ladder branches on, and what the emptied-set clear depends on.

A file that vanished between the walk and its `stat` SHALL be omitted rather than raising, because the
database and the filesystem routinely disagree and a gone file is honestly reported as absent.

#### Scenario: Enumeration matches staging's path set

- **WHEN** `enumerateInputPaths` and `stageInputs` run against the same inputs
- **THEN** the enumerated set SHALL equal the staged manifest's `relativePath` set exactly

#### Scenario: Enumeration performs no writes

- **WHEN** `enumerateInputPaths` runs for an analysis whose workspace tree does not exist
- **THEN** it returns the path set and creates no directory or file

#### Scenario: Enumeration hashes nothing

- **WHEN** `enumerateInputPaths` runs over a large input file
- **THEN** the file's content SHALL NOT be read

#### Scenario: Unresolvable inputs are skipped consistently

- **WHEN** one input's anchor cannot be resolved
- **THEN** the enumeration omits it, exactly as staging's walk would

#### Scenario: A vanished source is a removal, not a failure

- **WHEN** an input's row survives but its file was deleted from disk
- **THEN** the enumeration omits that path and stays in the ok channel
