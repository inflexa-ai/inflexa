## Why

The provenance module records W3C PROV documents as PROV-JSON blobs on `analyses.provenance` (a plain TEXT column in SQLite). Nothing prevents editing the database file directly — the system cannot detect that provenance was altered after the fact. For provenance to be meaningful (reproducibility claims, audit trails, regulatory compliance), it must be tamper-evident: any modification after recording must be detectable, and a verification command must let the user (or a third party) confirm integrity.

## What Changes

- **Ed25519 signing keypair** generated on first use, stored in the user's config directory. Used to sign provenance chain state at each flush.
- **Hash-chain integrity** at flush time: each flush computes `SHA-256(prev_chain_hash || serialized_prov_json)`, producing a rolling chain hash that makes insertion, deletion, or reordering of flush states detectable.
- **Ed25519 signature** over the chain hash, stored alongside the provenance. Proves the chain hash was produced by the holder of the private key — non-repudiation for third-party verification.
- **`inflexa prov verify <analysis>`** CLI + TUI command: recomputes the chain hash from the stored PROV-JSON, verifies the Ed25519 signature, and reports integrity status (pass/fail with detail).
- **Export includes integrity metadata**: `inflexa prov export` emits the signature and chain hash so a recipient with the public key can verify independently.
- **Graceful degradation**: missing keypair does not block recording — provenance is still captured, but unsigned. `verify` reports "unsigned" rather than failing.

## Capabilities

### New Capabilities
- `prov-signing`: Ed25519 keypair lifecycle (generation, storage, loading) and the sign/verify operations over provenance chain hashes.
- `prov-chain`: Hash-chain computation at flush time — rolling SHA-256 digest linking each flush state to its predecessor, plus the DB columns that persist chain hash and signature.
- `prov-verify`: The verification command (CLI `inflexa prov verify <analysis>` + TUI palette entry) that recomputes the chain, checks the signature, and reports integrity status.

### Modified Capabilities
- `cli-core`: New `prov verify` subcommand under the existing `prov` command group.
- `data-model-storage`: New columns on `analyses` for chain hash and signature (migration v3).
- `command-palette`: New "Verify provenance" TUI command entry.

## Impact

- **DB schema**: migration v3 adds `provenance_chain_hash TEXT` and `provenance_signature TEXT` columns to `analyses`.
- **Config directory**: new `prov_key.json` file at `<configDir>/inflexa/`.
- **`src/modules/prov/`**: new signing/chain logic alongside existing recorder and document modules.
- **`src/lib/env.ts`**: new `provKeyPath` entry for the keypair file path.
- **`src/cli/index.ts`**: `prov verify` subcommand registration.
- **`src/tui/commands.tsx`**: "Verify provenance" palette entry.
- **`src/modules/prov/export.ts`**: extended to include chain hash + signature in output.
- **Dependencies**: none — uses Bun's built-in `crypto.subtle` (WebCrypto Ed25519).
