## ADDED Requirements

### Requirement: Project create helper mints ids inline

The system SHALL provide `createProject({ name, description, tags })`, minting `id = randomUUIDv7()` and timestamps inline and persisting the row. `createProject` SHALL rely on the `projects.name` `UNIQUE` constraint, surfacing a duplicate as a `constraint_violation` (`unique`) for the caller to translate.

#### Scenario: Duplicate project name trips the constraint

- **WHEN** `createProject` is called with a name that already exists
- **THEN** it returns a `constraint_violation` error of constraint `unique` (no second row is created)

## REMOVED Requirements

### Requirement: Project and session create helpers mint ids inline

**Reason**: The `sessions` table is dropped with the SQLite chat store; the project half of this requirement survives as the added project-only requirement (removed-plus-added rather than modified because the requirement name itself named sessions).
**Migration**: `createSession` callers are deleted with the launcher's session resolution; thread rows are created lazily by the first turn.

### Requirement: Analysis-scoped session reads

**Reason**: The `sessions` table is dropped; the analysis-scoped listing lives on the harness thread store (`listThreads({analysisId})`), which already exists and orders by `updated_at` descending.
**Migration**: The session-switch picker and resume-most-recent resolution re-point to `ThreadStore.listThreads` over the booted runtime's pool.
