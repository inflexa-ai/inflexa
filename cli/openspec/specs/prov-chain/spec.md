# prov-chain Specification

## Purpose
The SHA-256 hash chain that binds each provenance flush to its predecessor and the Ed25519 signature stored alongside it — the runtime integrity layer that makes tampering detectable. Depends on `prov-signing` for the cryptographic primitives and `data-model-storage` for the migration that adds the integrity columns.
## Requirements
### Requirement: Hash chain computation at flush time

The system SHALL compute a chain hash on each provenance flush as `SHA-256(prev_chain_hash_bytes || prov_json_bytes)` where `prev_chain_hash_bytes` is the previously stored `provenance_chain_hash` decoded from hex (or `SHA-256("")` for the initial flush when no prior chain hash exists). The result SHALL be hex-encoded and stored in `analyses.provenance_chain_hash`.

#### Scenario: Initial flush computes chain hash from the empty seed

- **WHEN** the recorder flushes provenance for an analysis with no prior `provenance_chain_hash`
- **THEN** the chain hash is `SHA-256(SHA-256("") || prov_json_bytes)`
- **AND** the hex-encoded result is stored in `provenance_chain_hash`

#### Scenario: Subsequent flush chains from the previous hash

- **WHEN** the recorder flushes provenance for an analysis that already has a `provenance_chain_hash`
- **THEN** the new chain hash is `SHA-256(prev_chain_hash_bytes || prov_json_bytes)`
- **AND** the stored `provenance_chain_hash` is updated to the new value

#### Scenario: Chain hash cascades on modification

- **WHEN** the PROV-JSON at any point in an analysis's flush history is modified
- **THEN** recomputing the chain hash from the current PROV-JSON produces a different value than the stored `provenance_chain_hash`

### Requirement: Signature stored alongside chain hash

The system SHALL sign the chain hash with the Ed25519 private key (per `prov-signing`) after computing it, and store the hex-encoded signature in `analyses.provenance_signature`. Both columns SHALL be updated atomically in the same `UPDATE` statement as `provenance`.

#### Scenario: Flush writes provenance, chain hash, and signature together

- **WHEN** the recorder flushes and a signing keypair is available
- **THEN** `provenance`, `provenance_chain_hash`, and `provenance_signature` are all updated in a single SQL statement

#### Scenario: Flush without keypair writes provenance only

- **WHEN** the recorder flushes and no signing keypair is available
- **THEN** `provenance` is updated
- **AND** `provenance_chain_hash` and `provenance_signature` remain `NULL`

### Requirement: DB migration v3 adds integrity columns

The system SHALL add a migration `version: 3` in `src/db/primary_migrations.ts` that executes:
```sql
ALTER TABLE analyses ADD COLUMN provenance_chain_hash TEXT;
ALTER TABLE analyses ADD COLUMN provenance_signature TEXT;
```
Existing rows receive `NULL` for both columns, correctly treated as "unsigned" by the verification logic.

#### Scenario: Migration v3 adds columns to existing database

- **WHEN** the migration runner applies version 3 to a database at version 2
- **THEN** the `analyses` table gains `provenance_chain_hash` and `provenance_signature` columns
- **AND** existing rows have `NULL` for both

#### Scenario: Fresh database gets all migrations

- **WHEN** the migration runner executes against a fresh database
- **THEN** migrations 1, 2, and 3 are all applied
- **AND** `analyses` has `provenance`, `provenance_chain_hash`, and `provenance_signature` columns
