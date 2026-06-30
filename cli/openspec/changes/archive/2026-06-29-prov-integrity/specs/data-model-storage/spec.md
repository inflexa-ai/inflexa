## ADDED Requirements

### Requirement: Migration v3 adds provenance integrity columns

The system SHALL define a `version: 3` migration in `src/db/primary_migrations.ts` that adds `provenance_chain_hash TEXT` and `provenance_signature TEXT` columns to the `analyses` table via `ALTER TABLE`. Existing rows receive `NULL`, treated as "unsigned".

#### Scenario: Migration v3 is applied after v2

- **WHEN** the migration runner executes against a database at version 2
- **THEN** version 3 is applied
- **AND** `analyses` gains `provenance_chain_hash` and `provenance_signature` columns

#### Scenario: Column ordering follows house convention

- **WHEN** the migration adds columns
- **THEN** `provenance_chain_hash` and `provenance_signature` are added after `provenance` (core data, not FK columns)

### Requirement: DB accessors for integrity columns

The system SHALL provide `getAnalysisIntegrity(id): Result<{ chainHash: string | null, signature: string | null }, DbError>` in `src/db/primary_query.ts` and extend `updateAnalysisProvenance` in `src/db/primary_mutation.ts` to accept optional `chainHash` and `signature` parameters, writing all three columns in a single `UPDATE`.

#### Scenario: Read integrity columns

- **WHEN** `getAnalysisIntegrity(id)` is called for an analysis with stored integrity data
- **THEN** it returns the `provenance_chain_hash` and `provenance_signature` values

#### Scenario: Write provenance with integrity

- **WHEN** `updateAnalysisProvenance(id, prov, chainHash, signature)` is called
- **THEN** `provenance`, `provenance_chain_hash`, and `provenance_signature` are updated in one statement
