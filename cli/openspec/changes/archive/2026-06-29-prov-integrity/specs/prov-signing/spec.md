## ADDED Requirements

### Requirement: Ed25519 keypair generation on first use

The system SHALL generate an Ed25519 keypair via `crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])` on the first provenance flush that would produce a signature, if no keypair file exists at `env.provKeyPath`. The keypair SHALL be exported as JWK and written to `<configDir>/inflexa/prov_key.json` as `{ publicKey: JsonWebKey, privateKey: JsonWebKey }`.

#### Scenario: First flush generates keypair

- **WHEN** the provenance recorder flushes for the first time and no `prov_key.json` exists
- **THEN** an Ed25519 keypair is generated and written to `prov_key.json`
- **AND** the flush proceeds to sign the chain hash with the new key

#### Scenario: Existing keypair is loaded

- **WHEN** the provenance recorder flushes and `prov_key.json` already exists
- **THEN** the existing keypair is loaded via `crypto.subtle.importKey` and reused

#### Scenario: Unparseable keypair file is replaced with a fresh keypair

- **WHEN** `prov_key.json` exists but cannot be parsed as JSON
- **THEN** the system generates a fresh keypair and overwrites the file
- **AND** the flush proceeds to sign with the new key

#### Scenario: Structurally valid but wrong JWK degrades to unsigned

- **WHEN** `prov_key.json` parses as JSON but the JWK cannot be imported (wrong algorithm, missing fields)
- **THEN** the flush still writes the `provenance` column
- **AND** `provenance_chain_hash` and `provenance_signature` remain `NULL`
- **AND** a warning is logged

### Requirement: Signing operation over chain hash

The system SHALL sign a chain hash (a 32-byte SHA-256 digest, hex-encoded) using `crypto.subtle.sign("Ed25519", privateKey, chainHashBytes)` and produce a hex-encoded 64-byte Ed25519 signature.

#### Scenario: Sign produces a deterministic signature

- **WHEN** the same chain hash is signed with the same private key twice
- **THEN** both signatures are identical (Ed25519 is deterministic — no nonce)

### Requirement: Verification operation over chain hash and signature

The system SHALL verify a signature against a chain hash using `crypto.subtle.verify("Ed25519", publicKey, signatureBytes, chainHashBytes)`, returning a boolean.

#### Scenario: Valid signature verifies

- **WHEN** a chain hash is verified against the signature that signed it and the corresponding public key
- **THEN** verification returns `true`

#### Scenario: Tampered chain hash fails verification

- **WHEN** a chain hash is verified against a signature produced for a different hash
- **THEN** verification returns `false`

### Requirement: Keypair path in env

The system SHALL expose `env.provKeyPath` (at `<configDir>/inflexa/prov_key.json`) in `src/lib/env.ts`, following the existing pattern for `authPath` and `configPath`.

#### Scenario: provKeyPath is derived from configDir

- **WHEN** `env.provKeyPath` is read
- **THEN** it returns `<configDir>/inflexa/prov_key.json`
