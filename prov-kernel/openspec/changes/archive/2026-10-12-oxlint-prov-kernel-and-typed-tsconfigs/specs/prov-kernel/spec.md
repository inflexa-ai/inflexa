# prov-kernel — delta

## MODIFIED Requirements

### Requirement: Integrity is a chain hash under an Ed25519 signature

The chain rule SHALL be `H_n = SHA-256(bytes(H_{n-1}) || bytes(json_n))`,
seeded with `SHA-256("")` when no previous hash exists. Signatures SHALL be
Ed25519 over the hex-decoded digest bytes, hex-encoded. The export attestation
SHALL be self-contained (payload digest, signature, and public JWK) and SHALL
validate under `attestationSchema`. The public JWK SHALL carry `kty` `OKP`,
`crv` `Ed25519`, and the base64url `x` key material, and members beyond the
three SHALL stay permitted, as JWK defines optional members. The attestation
was named the "sidecar" before version 0.4.0; the object's field names do not
carry the old name, thus existing artifacts verify unchanged. Provenance SHALL
never be written or exported unsigned — every signing failure surfaces as a
`ProvSigningError` on the err channel.

#### Scenario: A correct chain link verifies

- **GIVEN** a stored PROV-JSON, its previous chain hash, its chain hash, and
  a signature by the signer's key
- **WHEN** `verifyProvenance` recomputes the chain and checks the signature
- **THEN** the result is `valid`

#### Scenario: Tampering is detected

- **GIVEN** a payload modified after signing, or a wrong previous hash, or a
  signature over a different digest
- **WHEN** verification runs
- **THEN** the result is `tampered` with a human-readable detail

#### Scenario: An attestation round-trips

- **GIVEN** an attestation built by `buildAttestation` over a payload
- **WHEN** the attestation parses under `attestationSchema` and
  `verifyAttestation` runs against the same payload
- **THEN** the result is `valid`

#### Scenario: A JWK that is not an Ed25519 OKP key fails the schema

- **GIVEN** an attestation whose `publicKey` lacks `kty` `OKP`, `crv`
  `Ed25519`, or the base64url `x` key material
- **WHEN** the attestation parses under `attestationSchema`
- **THEN** the parse fails, and an attestation with the three members and
  further JWK members parses
