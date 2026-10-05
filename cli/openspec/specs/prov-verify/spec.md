# prov-verify Specification

## Purpose
The verification surface for provenance integrity — the pure `verifyProvenance` function, the `VerifyResult` discriminated union, the `prov verify` and `prov verify-file` CLI commands, the TUI palette entry, and the self-describing DSSE-style export sidecar. Lives in `src/modules/prov/verify.ts` (logic + CLI actions) and `src/modules/prov/export.ts` (sidecar writing).

## Requirements

### Requirement: CLI verify command

The system SHALL register `inflexa prov verify <analysis>` as a client of the local server. It SHALL resolve the analysis by id-or-name through the resolve route of the server, and a name that more analyses share SHALL fail with each candidate rather than pick one. The server SHALL recompute the chain hash from the stored PROV-JSON, verify the stored signature against the public key, and return the verification result (`GET {A}/provenance/verify`). The command SHALL print the result, and SHALL exit non-zero for `tampered` and `verify-error`.

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

#### Scenario: An ambiguous name names each candidate

- **WHEN** `inflexa prov verify shared-name` runs and two analyses have that name
- **THEN** it exits non-zero and lists each candidate with its id, so the user can run it again with an exact id

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

### Requirement: TUI verify command

The system SHALL add a "Verify provenance (internal)" entry to the command palette (category "Analysis"), enabled when an analysis is open. It SHALL ask the local server for the verification result of the stored chain (`GET {A}/provenance/verify`) and display the result as a notice. A failed request SHALL display an error notice. The system SHALL also add a "Verify provenance (export)" entry. For it, the server SHALL name the path of the exported `provenance.json` of the analysis. Then the TUI process SHALL verify that file against its attestation, the same as `inflexa prov verify-file`, because the check reads only the two files.

#### Scenario: TUI verify shows result as notice

- **WHEN** the user selects "Verify provenance (internal)" from the command palette
- **THEN** a notice is displayed with the verification status that the server returned

#### Scenario: An export with no attestation is named

- **WHEN** the user selects "Verify provenance (export)" and the analysis has no exported `provenance.json`
- **THEN** a notice tells the user to export the provenance first

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

#### Scenario: Export with signature writes sidecar

- **WHEN** `inflexa prov export my-analysis --format json` runs and the analysis has a stored signature and the public key is available
- **THEN** it writes `provenance.json` and `provenance.json.sig.json` to the output directory
- **AND** the attestation contains `payloadType`, `payloadDigestAlgorithm`, `payloadDigest`, `payloadDigestMethod`, `signatureAlgorithm`, `signature`, and `publicKey`

#### Scenario: Export hard-fails when signing is impossible — never exported unsigned

- **WHEN** `inflexa prov export my-analysis --format json` runs but signing cannot complete (the keypair file is corrupt, or a crypto operation fails, so `buildAttestation` returns `err(ProvSigningError)`)
- **THEN** the command prints `Signing failed (<type>) — provenance is never exported unsigned.` and exits non-zero via `fail()`
- **AND** it does not silently succeed by writing only `provenance.json`: a JSON export always signs (the key is generated on first use), so an unsignable export is a hard failure, not a graceful "provenance only" path

#### Scenario: Third-party verification with sidecar

- **WHEN** a third party has `provenance.json` and `provenance.json.sig.json`
- **THEN** they read `payloadDigestAlgorithm` and `signatureAlgorithm` from the attestation
- **AND** they compute `SHA-256(file_contents)` over the provenance file bytes
- **AND** they compare the result to `payloadDigest`
- **AND** they verify the `signature` against the `payloadDigest` bytes using the `publicKey` with `Ed25519`

### Requirement: The export runs in the local server after a recorder flush

`inflexa prov export` and the export entries of the TUI palette SHALL be clients of `POST {A}/provenance/export`. The server SHALL flush the in-memory appends of the provenance recorder into the signed chain before it serializes the document, thus each export holds each event that the server recorded. A flush that fails SHALL NOT stop the export: the export then holds the last stored chain. The command SHALL resolve `--output` against its own working folder and send the absolute path. Without `--output`, the server SHALL write into the output folder of the analysis. A signing failure SHALL refuse the export with its signing error named, and nothing SHALL be written.

#### Scenario: An export includes the newest events

- **GIVEN** a server whose recorder holds an input change that it did not flush yet
- **WHEN** `inflexa prov export my-analysis` runs
- **THEN** the written document holds that input change

#### Scenario: A relative output path is the folder of the command

- **WHEN** `inflexa prov export my-analysis --output out/prov.json` runs in the folder `/work`
- **THEN** the server writes `/work/out/prov.json`, not a path under the folder of the server process
