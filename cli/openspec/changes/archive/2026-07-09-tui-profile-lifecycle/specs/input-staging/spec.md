# input-staging Delta

## ADDED Requirements

### Requirement: Identity-only input enumeration

The system SHALL provide `enumerateInputFileIds(analysisId)` in `src/modules/staging/` returning the
`Result`-typed set of deterministic `fileId`s that `stageInputs` would produce for the analysis's
current inputs — the same derivation and the same walk rules (noise-directory skips, symlink
handling, unresolvable inputs skipped) — while writing nothing to the session tree, hashing no file
content, and not requiring the session tree to exist. Its cost SHALL be bounded by directory
enumeration (stat/readdir), never by input content size, so parity drift checks can run on every
chat open and every input mutation. The identity walk SHALL be single-sourced with staging's walk:
the two MUST NOT be able to drift on which files an input yields.

#### Scenario: Enumeration matches staging's identity set

- **WHEN** `enumerateInputFileIds` and `stageInputs` run against the same inputs
- **THEN** the enumerated set equals exactly the set of `fileId`s in the staged manifest

#### Scenario: Enumeration performs no writes

- **WHEN** `enumerateInputFileIds` runs for an analysis whose session tree does not exist
- **THEN** it returns the identity set and creates no directory or file

#### Scenario: Unresolvable inputs are skipped consistently

- **WHEN** one input's anchor cannot be resolved
- **THEN** the enumeration omits it, exactly as staging's walk would
