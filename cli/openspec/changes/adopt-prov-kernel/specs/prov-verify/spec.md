## RENAMED Requirements

- FROM: `### Requirement: Export includes a self-describing verification sidecar`
- TO: `### Requirement: Export includes a self-describing verification attestation`

## MODIFIED Requirements

### Requirement: Verification result type

The verification result SHALL be the kernel's discriminated union `VerifyResult`
(`@inflexa-ai/prov-kernel`, re-exported from `src/types/prov.ts` — the cli defines no
copy) with the following variants:
- `{ status: "valid" }` — the chain hash (DB path) or payload digest (file path) recomputes correctly AND the Ed25519 signature verifies.
- `{ status: "unsigned" }` — no chain hash / signature is stored (a legacy row recorded before integrity was enabled; current flushes never persist unsigned, so new writes cannot produce this state).
- `{ status: "tampered"; detail: string }` — the recomputed chain hash or payload digest does not match the stored value, or the signature does not verify; `detail` names which.
- `{ status: "no-key" }` — a signature is stored but the public key is missing, so it cannot be verified.
- `{ status: "empty" }` — no provenance has been recorded for the analysis.
- `{ status: "invalid-attestation"; detail: string }` — (file path) the `.sig.json` attestation is missing, malformed, or fails schema validation.
- `{ status: "invalid-key" }` — (file path) the public key embedded in the attestation cannot be imported as an Ed25519 key.
- `{ status: "verify-error"; detail: string }` — a crypto operation (chain-hash/digest computation or signature verification) failed internally; `detail` carries the cause.

#### Scenario: Each verification outcome maps to exactly one variant

- **WHEN** verification is performed
- **THEN** the result is exactly one of the eight `VerifyResult` variants

### Requirement: Verification logic is pure and testable

The verification logic SHALL be the kernel's pure functions (`verifyProvenance`,
`verifyPayload`, `verifyAttestation`) that take the stored PROV-JSON, stored chain hash
or digest, stored signature, and public key (or null), and return a `VerifyResult`.
They SHALL NOT perform DB queries or file I/O — the cli's `verifyAnalysisIntegrity`
and `verifyExportFile` wrap them with the storage reads (integrity columns,
`.sig.json` files, the key file).

#### Scenario: Verification function is testable without DB

- **WHEN** the verify function is called with in-memory inputs (prov JSON, chain hash, signature, public key)
- **THEN** it returns a `VerifyResult` without touching the database or filesystem

### Requirement: Export includes a self-describing verification attestation

The system SHALL extend `inflexa prov export` to write an attestation file `provenance.<format>.sig.json` alongside the provenance document when a signature is available (the on-disk `.sig.json` suffix is a continuity-load-bearing convention and does NOT rename). The attestation SHALL be the kernel's schema (`attestationSchema` / `buildAttestation` from `@inflexa-ai/prov-kernel`; the cli supplies the signer from its keypair file) — a self-describing envelope containing all the metadata a third party needs to verify independently:
```json
{
  "payloadType": "application/json; profile=prov-json",
  "payloadDigestAlgorithm": "SHA-256",
  "payloadDigest": "<hex-encoded SHA-256 content digest>",
  "payloadDigestMethod": "verbatim",
  "signatureAlgorithm": "Ed25519",
  "signature": "<hex-encoded Ed25519 signature over the digest>",
  "publicKey": { "kty": "OKP", "crv": "Ed25519", ... }
}
```
`payloadDigestMethod: "verbatim"` declares the digest was computed over the exact stored bytes (not a canonicalized form). This aligns with DSSE's approach of treating the payload as an opaque blob to avoid canonicalization. The JSON wire fields are unchanged by the attestation naming. The kernel schema additionally allows an OPTIONAL `kid` signer id; the cli does not set it, and attestations without it validate unchanged.

#### Scenario: Export with signature writes the attestation

- **WHEN** `inflexa prov export my-analysis --format json` runs and the analysis has a stored signature and the public key is available
- **THEN** it writes `provenance.json` and `provenance.json.sig.json` to the output directory
- **AND** the attestation contains `payloadType`, `payloadDigestAlgorithm`, `payloadDigest`, `payloadDigestMethod`, `signatureAlgorithm`, `signature`, and `publicKey`

#### Scenario: Export hard-fails when signing is impossible — never exported unsigned

- **WHEN** `inflexa prov export my-analysis --format json` runs but signing cannot complete (the keypair file is corrupt, or a crypto operation fails, so `buildAttestation` returns `err(ProvSigningError)`)
- **THEN** the command prints `Signing failed (<type>) — provenance is never exported unsigned.` and exits non-zero via `fail()`
- **AND** it does not silently succeed by writing only `provenance.json`: a JSON export always signs (the key is generated on first use), so an unsignable export is a hard failure, not a graceful "provenance only" path

#### Scenario: Third-party verification with the attestation

- **WHEN** a third party has `provenance.json` and `provenance.json.sig.json`
- **THEN** they read `payloadDigestAlgorithm` and `signatureAlgorithm` from the attestation
- **AND** they compute `SHA-256(file_contents)` over the provenance file bytes
- **AND** they compare the result to `payloadDigest`
- **AND** they verify the `signature` against the `payloadDigest` bytes using the `publicKey` with `Ed25519`
