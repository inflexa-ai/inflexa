# write-boundary Delta

## MODIFIED Requirements

### Requirement: Compute an analysis's read/write roots

The system SHALL provide `computeRoots(analysis)` returning `Result<Roots, WorkspaceError>` in `src/modules/analysis/boundary.ts`, where `writable` is exactly one path — the resolved (and created) analysis workspace root, `<anchorPath>/.inflexa/analyses/<slug>/`, the same tree that holds staged inputs, run artifacts, and provenance exports — and `readable` is every input resolved to an absolute path plus the workspace root. Inputs that resolve to `null` SHALL be dropped from `readable`. When the workspace root itself cannot be resolved (unresolvable or non-writable anchor), `computeRoots` SHALL return that err — there is no fallback root.

#### Scenario: Roots include inputs and the workspace root

- **WHEN** `computeRoots(analysis)` runs for an analysis with resolvable inputs
- **THEN** `writable` contains exactly the workspace root
- **AND** `readable` contains each resolved input path and the workspace root

#### Scenario: Unresolvable inputs are dropped

- **WHEN** an input reference resolves to `null` (its anchor cannot be resolved)
- **THEN** that input is omitted from `readable` rather than included as null

#### Scenario: Unresolvable workspace root is an error

- **WHEN** the analysis's own anchor cannot be resolved or is not writable
- **THEN** `computeRoots` returns an err rather than substituting another writable root
