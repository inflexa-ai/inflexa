## MODIFIED Requirements

### Requirement: Signing operation over chain hash

The system SHALL sign a chain hash (a 32-byte SHA-256 digest, hex-encoded) with an
Ed25519 private key, producing a hex-encoded 64-byte signature. The primitive is the
kernel's `signHexDigest` (`@inflexa-ai/prov-kernel`); the cli SHALL NOT carry its own
copy. The cli owns only the keypair FILE lifecycle (generate-on-first-use, JWK
persistence at `env.provKeyPath`, race-safe adoption) and imports a stored pair through
the kernel's `importPrivateKeyJwk`/`importPublicKeyJwk`.

#### Scenario: Sign produces a deterministic signature

- **WHEN** the same chain hash is signed with the same private key twice
- **THEN** both signatures are identical (Ed25519 is deterministic — no nonce)

### Requirement: Verification operation over chain hash and signature

The system SHALL verify a signature against a chain hash, returning a boolean. The
primitive is the kernel's `verifyHexDigest`; the cli SHALL NOT carry its own copy.

#### Scenario: Valid signature verifies

- **WHEN** a chain hash is verified against the signature that signed it and the corresponding public key
- **THEN** verification returns `true`

#### Scenario: Tampered chain hash fails verification

- **WHEN** a chain hash is verified against a signature produced for a different hash
- **THEN** verification returns `false`
