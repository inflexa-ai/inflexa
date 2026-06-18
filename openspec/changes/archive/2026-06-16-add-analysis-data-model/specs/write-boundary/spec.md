## ADDED Requirements

### Requirement: Compute an analysis's read/write roots

The system SHALL provide `computeRoots(analysis)` returning `Result<Roots, DbError>` in `src/modules/analysis/boundary.ts`, where `writable` is exactly one path — the resolved (and created) output directory — and `readable` is every input resolved to an absolute path plus the output directory. Inputs that resolve to `null` SHALL be dropped from `readable`.

#### Scenario: Roots include inputs and the output directory

- **WHEN** `computeRoots(analysis)` runs for an analysis with resolvable inputs
- **THEN** `writable` contains exactly the output directory
- **AND** `readable` contains each resolved input path and the output directory

#### Scenario: Unresolvable inputs are dropped

- **WHEN** an input reference resolves to `null` (its anchor cannot be resolved)
- **THEN** that input is omitted from `readable` rather than included as null

### Requirement: Deny-first write guard

The system SHALL provide `canWrite(roots, absPath)` returning true if and only if `absPath` is within the single writable root, using a path-boundary-safe containment check (trailing-separator prefix), and false otherwise (deny-first).

#### Scenario: Write inside the output directory is allowed

- **WHEN** `canWrite(roots, "<outputDir>/result.txt")` is checked
- **THEN** it returns true

#### Scenario: Write outside the output directory is denied

- **WHEN** `canWrite(roots, "<someInput>/data.csv")` is checked
- **THEN** it returns false

#### Scenario: Sibling-prefix paths are not considered inside

- **WHEN** the writable root is `/a/b` and the path is `/a/bc`
- **THEN** `canWrite` returns false

### Requirement: Deny-first read guard

The system SHALL provide `canRead(roots, absPath)` returning true if and only if `absPath` is within any readable root (which includes the writable output directory), using the same boundary-safe containment, and false otherwise.

#### Scenario: Read of a declared input is allowed

- **WHEN** `canRead(roots, "<declaredInput>/file")` is checked
- **THEN** it returns true

#### Scenario: Read inside the output directory is allowed

- **WHEN** `canRead(roots, "<outputDir>/result.txt")` is checked
- **THEN** it returns true (the writable root is also readable)

#### Scenario: Read outside all roots is denied

- **WHEN** `canRead(roots, "/etc/passwd")` is checked and that path is in no root
- **THEN** it returns false

### Requirement: Structural, advisory boundary; gating deferred

The boundary SHALL be structural (a single writable root, no per-input or per-folder access mode) and documented as an application-layer (advisory) contract, not OS sandboxing. When the agent gains file read/write tools, those tools SHALL be gated through `canRead`/`canWrite`; no agent file tool exists yet, so the guards are built and ready but not yet wired into the chat backend (the gating integration is deferred).

#### Scenario: No per-input access modes

- **WHEN** the boundary is computed
- **THEN** there is a single writable root and no per-input access flags

#### Scenario: Guards are the designated gating point

- **WHEN** the agent backend later gains file tools
- **THEN** those tools are required to consult `canRead`/`canWrite` for the active analysis before reading or writing a path
