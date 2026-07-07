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

#### Scenario: Flush cannot obtain a signing key — nothing is persisted

- **WHEN** the recorder flushes but the signing key cannot be obtained (corrupt keypair file, generation failure, or a lost keygen race — the key is generated on first use, so this is a hard fault, not the normal path)
- **THEN** NO column is written — `provenance`, `provenance_chain_hash`, and `provenance_signature` are all left unchanged
- **AND** the analysis is retained as dirty so a later append retries the flush; a persistent failure surfaces as a logged `provenance flush could not drain — signing or persist is failing`

### Requirement: Integrity columns are part of the baseline schema

The `analyses` table SHALL declare all four provenance columns — `provenance TEXT`, `provenance_chain_hash TEXT`, `provenance_signature TEXT`, and `provenance_prev_chain_hash TEXT` — in the single `version: 1` baseline migration in `src/db/primary_migrations.ts`. There is no separate `ALTER TABLE` / `version: 2` / `version: 3` migration; the columns exist from the first migration. A newly created analysis row has `NULL` in all four until its first signed flush, which the verifier reads as `unsigned` (or `empty` when `provenance` itself is `NULL`).

The dedicated `provenance_prev_chain_hash` column holds the chain hash of the PREVIOUS flush, so the verifier can recompute `chainHash = SHA-256(provenance_prev_chain_hash || provenance)` from stored data alone. `updateAnalysisProvenance` rotates it in the same atomic `UPDATE`: it copies the current `provenance_chain_hash` into `provenance_prev_chain_hash` before writing the new `provenance_chain_hash` and `provenance_signature`.

#### Scenario: Baseline migration creates all four integrity columns

- **WHEN** the migration runner executes against a fresh database
- **THEN** migration 1 is applied and `analyses` has `provenance`, `provenance_chain_hash`, `provenance_signature`, and `provenance_prev_chain_hash` columns
- **AND** a row that has never been flushed has `NULL` in all four

#### Scenario: prev_chain_hash rotates on each flush

- **WHEN** `updateAnalysisProvenance` persists a new signed flush
- **THEN** the same `UPDATE` copies the current `provenance_chain_hash` into `provenance_prev_chain_hash` before writing the new `provenance_chain_hash` and `provenance_signature`
