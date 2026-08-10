# Rename the sidecar to the attestation

## Why

"Sidecar" names where the object travels — a file next to another file. It
does not name what the object is: a signed attestation of a payload — the
digest, the signature, and the public key that let a recipient verify
integrity with no other state. Hosts that store the object in a database
column have no "side" at all, and the name misleads there. "Attestation" names
the function, in every transport.

## What Changes

- Rename the public surface, with NO deprecated aliases:
  - `buildSidecar` → `buildAttestation`
  - `verifySidecar` → `verifyAttestation`
  - `sidecarSchema` → `attestationSchema`
  - type `Sidecar` → `ProvAttestation`
  - the `VerifyResult` status `invalid-sidecar` → `invalid-attestation`
- Internal names, doc comments, tests, `README.md`, `CLAUDE.md`, and
  `scripts/smoke.mjs` follow.
- `SPEC.md`: rename "The sidecar" section to "The attestation", with one line
  that gives the former name — the wire contract is a public document and
  artifacts exist in the wild under the old name.
- The JSON payload itself is UNCHANGED: no field name contains "sidecar", so
  every existing artifact verifies as before.
- Bump the package version from 0.3.0 to 0.4.0 (shared with the
  add-lineage-read-model change).

## Capabilities

### Modified Capabilities

- `prov-kernel`: the boundary, integrity, and wire-format requirements name
  the attestation instead of the sidecar. The semantics do not change.

## Impact

- `src/verify.ts`, `src/verify.test.ts`, `src/types.ts`, `src/signing.ts`
  (doc comments), `src/index.ts`, `SPEC.md`, `README.md`, `CLAUDE.md`,
  `scripts/smoke.mjs`, `package.json`.
- Breaking for the API surface at 0.x. Every consumer is an in-flight pull
  request under our control, thus a clean rename beats a deprecation window.
