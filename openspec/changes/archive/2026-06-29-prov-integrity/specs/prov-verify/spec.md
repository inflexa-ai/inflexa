## ADDED Requirements

### Requirement: CLI verify command

The system SHALL register `inflexa prov verify <analysis>` that resolves the analysis by id-or-name (per the existing resolver pattern), recomputes the chain hash from the stored PROV-JSON, verifies the stored signature against the public key, and prints the verification result.

#### Scenario: Valid signed provenance

- **WHEN** `inflexa prov verify my-analysis` runs against an analysis with a valid signature
- **THEN** it prints a success message indicating the provenance chain is intact and the signature is valid

#### Scenario: Tampered provenance

- **WHEN** `inflexa prov verify my-analysis` runs against an analysis whose `provenance` column was modified after signing
- **THEN** it prints a failure message indicating the provenance has been tampered with
- **AND** the exit code is non-zero

#### Scenario: Unsigned provenance

- **WHEN** `inflexa prov verify my-analysis` runs against an analysis with `NULL` chain hash and signature
- **THEN** it prints a message indicating the provenance is unsigned (recorded before integrity was enabled or without a keypair)

#### Scenario: Missing public key

- **WHEN** `inflexa prov verify my-analysis` runs with a stored signature but the `prov_key.json` file is absent
- **THEN** it prints a message indicating the signature exists but cannot be verified without the key

#### Scenario: No provenance recorded

- **WHEN** `inflexa prov verify my-analysis` runs against an analysis with `NULL` provenance
- **THEN** it prints a message indicating no provenance has been recorded yet

#### Scenario: Unknown analysis

- **WHEN** `inflexa prov verify nonexistent` runs
- **THEN** it prints an error that no analysis matches the reference

### Requirement: File-based verification command

The system SHALL register `inflexa prov verify-file <path>` that verifies a provenance file against its sidecar without requiring a local database or analysis row. It SHALL locate the sidecar at `<path>.sig.json`, read the provenance file bytes and the sidecar JSON, recompute the chain hash from the file bytes, and verify the signature using the public key from the sidecar.

#### Scenario: Valid signed provenance file

- **WHEN** `inflexa prov verify-file provenance.json` runs and `provenance.json.sig.json` exists with a valid signature
- **THEN** it prints a success message indicating the provenance file is intact and the signature is valid

#### Scenario: Tampered provenance file

- **WHEN** `inflexa prov verify-file provenance.json` runs and the file contents do not match the sidecar's `payloadDigest`
- **THEN** it prints a failure message indicating the file has been tampered with
- **AND** the exit code is non-zero

#### Scenario: Missing sidecar

- **WHEN** `inflexa prov verify-file provenance.json` runs and `provenance.json.sig.json` does not exist
- **THEN** it prints a message indicating no sidecar was found and the file cannot be verified

#### Scenario: Missing provenance file

- **WHEN** `inflexa prov verify-file nonexistent.json` runs and the file does not exist
- **THEN** it prints an error that the file was not found

### Requirement: Verification result type

The system SHALL define a discriminated union `VerifyResult` with the following variants:
- `{ status: "valid" }` — chain hash recomputes correctly AND signature verifies.
- `{ status: "unsigned" }` — no signature stored.
- `{ status: "tampered"; detail: string }` — chain hash or signature does not verify.
- `{ status: "no-key" }` — signature exists but public key is missing.
- `{ status: "empty" }` — no provenance recorded.

#### Scenario: Each verification outcome maps to exactly one variant

- **WHEN** verification is performed
- **THEN** the result is exactly one of the five `VerifyResult` variants

### Requirement: Verification logic is pure and testable

The verification logic SHALL be a pure function that takes the stored PROV-JSON, stored chain hash, stored signature, and public key (or null), and returns a `VerifyResult`. It SHALL NOT perform DB queries or file I/O itself — the caller provides the inputs.

#### Scenario: Verification function is testable without DB

- **WHEN** the verify function is called with in-memory inputs (prov JSON, chain hash, signature, public key)
- **THEN** it returns a `VerifyResult` without touching the database or filesystem

### Requirement: TUI verify command

The system SHALL add a "Verify provenance" entry to the command palette (category "Analysis"), enabled when an analysis is open, that runs the verification logic and displays the result as a notice.

#### Scenario: TUI verify shows result as notice

- **WHEN** the user selects "Verify provenance" from the command palette
- **THEN** a notice is displayed with the verification status (valid/unsigned/tampered/no-key/empty)

### Requirement: Export includes a self-describing verification sidecar

The system SHALL extend `inflexa prov export` to write a sidecar file `provenance.<format>.sig.json` alongside the provenance document when a signature is available. The sidecar SHALL be a self-describing envelope containing all the metadata a third party needs to verify independently:
```json
{
  "payloadType": "application/json; profile=prov-json",
  "payloadDigestAlgorithm": "SHA-256",
  "payloadDigest": "<hex-encoded SHA-256 chain hash>",
  "payloadDigestMethod": "verbatim",
  "signatureAlgorithm": "Ed25519",
  "signature": "<hex-encoded Ed25519 signature over the digest>",
  "publicKey": { "kty": "OKP", "crv": "Ed25519", ... }
}
```
`payloadDigestMethod: "verbatim"` declares the digest was computed over the exact stored bytes (not a canonicalized form). This aligns with DSSE's approach of treating the payload as an opaque blob to avoid canonicalization.

#### Scenario: Export with signature writes sidecar

- **WHEN** `inflexa prov export my-analysis --format json` runs and the analysis has a stored signature and the public key is available
- **THEN** it writes `provenance.json` and `provenance.json.sig.json` to the output directory
- **AND** the sidecar contains `payloadType`, `payloadDigestAlgorithm`, `payloadDigest`, `payloadDigestMethod`, `signatureAlgorithm`, `signature`, and `publicKey`

#### Scenario: Export without signature writes no sidecar

- **WHEN** `inflexa prov export my-analysis` runs and the analysis has no stored signature
- **THEN** it writes only `provenance.json` (no `.sig.json` sidecar)

#### Scenario: Third-party verification with sidecar

- **WHEN** a third party has `provenance.json` and `provenance.json.sig.json`
- **THEN** they read `payloadDigestAlgorithm` and `signatureAlgorithm` from the sidecar
- **AND** they compute `SHA-256(SHA-256("") || file_contents)` over the provenance file bytes
- **AND** they compare the result to `payloadDigest`
- **AND** they verify the `signature` against the `payloadDigest` bytes using the `publicKey` with `Ed25519`
