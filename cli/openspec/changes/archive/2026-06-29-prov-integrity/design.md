## Context

The provenance module (`src/modules/prov/`) records W3C PROV documents (via `@inflexa-ai/tsprov`) as PROV-JSON blobs on `analyses.provenance` — a plain TEXT column in SQLite. Recording is bus-driven: analysis mutations emit typed `prov.*` events, the recorder appends to an in-memory `ProvDocument`, and a coalesced async flush (+ sync exit backstop) persists the serialized JSON to the column.

There is currently no integrity mechanism. The SQLite file is a user-local file; anyone (or a bug) can edit the provenance column and the system cannot detect it. For provenance to serve reproducibility claims, audit trails, or regulatory compliance, it must be tamper-evident.

A prior research spike (`prov.research.old.md`) evaluated a full Merkle tree transparency log (Go + PostgreSQL, Trillian/Tessera patterns, compact ranges, subtree tiles, witness protocol). That approach was rejected as disproportionate for a single-user local CLI tool — it targets multi-party server environments with billions of entries and mutual distrust between the log operator and its clients. We retain the hash-chain and signing concepts.

## Goals / Non-Goals

**Goals:**
- Tamper-evidence: any modification to stored provenance after recording is detectable.
- Non-repudiation: a third party with the public key can independently verify that the provenance was produced by the holder of the signing key.
- A `verify` command (CLI + TUI) that checks integrity and reports pass/fail with detail.
- Graceful degradation: missing keypair does not block recording — provenance is still captured unsigned.
- Zero new dependencies: uses Bun's built-in `crypto.subtle` (WebCrypto Ed25519).

**Non-Goals:**
- Distributed transparency log (Merkle tree, witnesses, inclusion/consistency proofs).
- Cross-analysis global ordering or a process-wide append-only log.
- Key management ceremony (HSM, KMS, key rotation protocol) — first-use generation is sufficient for local use.
- Encrypting provenance at rest — tamper-evidence, not confidentiality.
- Backward-compatible verification of provenance recorded before this change (pre-existing unsigned documents verify as "unsigned", not "tampered").

## Decisions

### D1: Ed25519 via WebCrypto — no new dependencies

**Decision:** use `crypto.subtle.generateKey`, `crypto.subtle.sign`, `crypto.subtle.verify` with the `Ed25519` algorithm (supported in Bun's WebCrypto).

**Alternatives considered:**
- `tweetnacl` / `@noble/ed25519`: adds a dependency; Bun's native WebCrypto is faster and already available.
- HMAC-only (no asymmetric key): detects tampering but provides no non-repudiation — a third party cannot verify because the secret is shared. Rejected because export + third-party verification is a goal.
- RSA / ECDSA P-256: larger signatures, no advantage for this use case. Ed25519 is deterministic (no nonce-reuse risk), produces 64-byte signatures, and is the dominant choice in the transparency-dev ecosystem.

### D2: Sign the chain state at flush time, not per action

**Decision:** the signing unit is the flush — after serializing the `ProvDocument` to PROV-JSON, compute `SHA-256(prev_chain_hash || prov_json)` and sign the resulting chain hash. One signature per flush, not per `appendCreation`/`appendInputAdded`/`appendInputRemoved`.

**Rationale:** a flush is the persistence boundary — the PROV-JSON blob on the column is the canonical serialization of all actions. Signing the blob after `unified().serialize("json")` covers everything that was appended since the last flush. Signing per action would require a separate persistence layer for intermediate signatures and would not add integrity (the actions exist only in memory between flushes; the column is the attack surface).

**The chain hash links flushes:** `H_n = SHA-256(H_{n-1} || prov_json_n)`. The initial `H_0` is `SHA-256("")` (the empty-tree convention from RFC 6962). This chain makes insertion, deletion, or reordering of flush states detectable — a modified `prov_json` at any point in the chain cascades through all subsequent hashes.

### D3: Two new columns on `analyses` — not a sibling table

**Decision:** add `provenance_chain_hash TEXT` and `provenance_signature TEXT` to the `analyses` table in migration v3. Both are hex-encoded strings (chain hash: 64 hex chars; signature: 128 hex chars). `NULL` until first signed flush.

**Alternatives considered:**
- Sibling `prov_integrity` table with a row per flush (full audit trail of every chain state): provides a historical log of every intermediate hash, but the PROV document itself already contains the full history (it is append-only — `unified()` never drops records). The chain hash and signature of the *latest* flush are sufficient to verify the *current* document, which is the goal. A historical log would add write amplification for no additional tamper-evidence.
- Embed in the PROV-JSON itself (as a custom `inflexa:` attribute): pollutes the W3C PROV document with non-PROV metadata; harder to strip for interop. Keeping integrity metadata in SQL columns keeps the PROV document clean.

### D4: Keypair lifecycle — generate on first sign, store as JWK

**Decision:** on the first flush that would produce a signature, if no keypair file exists at `env.provKeyPath`, generate an Ed25519 keypair via `crypto.subtle.generateKey`, export both keys as JWK, and write them to `<configDir>/inflexa/prov_key.json`. Subsequent loads import from the file.

**Format:** JWK (JSON Web Key) — the WebCrypto native export format. The file contains `{ publicKey: JWK, privateKey: JWK }`. The public key is also what gets included in an export bundle for third-party verification.

**Missing keypair = unsigned:** if the keypair file cannot be read (permissions, deleted, first run before any flush), the flush still writes `provenance` but leaves `provenance_chain_hash` and `provenance_signature` as `NULL`. The `verify` command reports "unsigned" for these analyses.

### D5: Verification recomputes, does not trust stored chain hash

**Decision:** `inflexa prov verify <analysis>` does NOT trust the stored `provenance_chain_hash`. It recomputes `SHA-256("" || prov_json)` from the stored `provenance` column (for the current single-flush model, `H_0 || prov_json` where `H_0 = SHA-256("")`), then verifies the stored `provenance_signature` against the recomputed hash using the public key. This means even if someone tampers with both the PROV-JSON and the chain hash, the signature check catches it (they don't have the private key).

**Verification result states:**
- `valid`: chain hash recomputes correctly AND signature verifies against the public key.
- `unsigned`: no signature stored (pre-integrity provenance or missing keypair at recording time).
- `tampered`: chain hash or signature does not verify — provenance was modified after signing.
- `no-key`: signature exists but the public key file is missing — cannot verify (distinct from tampered).
- `empty`: no provenance recorded yet.

### D6: Export includes a verification bundle

**Decision:** `inflexa prov export` gains an optional `--signed` flag (or always includes when available) that writes a sidecar `provenance.<format>.sig.json` file containing `{ chainHash, signature, publicKey }`. A third party can verify the exported PROV document against this bundle without access to the original database.

## Risks / Trade-offs

- **[Key compromise]** → If the private key file is stolen, an attacker can sign forged provenance. **Mitigation:** the keypair file lives in the user's config directory (same trust boundary as their auth tokens); a compromised local machine defeats all local-only integrity. Future: support hardware keys or external signers.
- **[Key loss]** → If the keypair file is deleted, existing signed provenance becomes `no-key` (signature exists but can't be verified). **Mitigation:** `verify` distinguishes `no-key` from `tampered`; the user knows the key is missing vs. the data was modified. Future: key backup/export command.
- **[Async flush window]** → Between a bus event and the next flush, in-memory appends are unsigned. A crash in this window loses the un-flushed tail (existing accepted trade-off from the A decision). The integrity mechanism does not change this — it signs what reaches the column. **Mitigation:** the sync exit backstop (`process.on("exit", flushProvenance)`) covers clean quits.
- **[Performance]** → SHA-256 + Ed25519 sign on every flush. SHA-256 of a typical PROV-JSON (~1-10 KB) is sub-microsecond; Ed25519 sign is ~50 μs on modern hardware. Negligible compared to the SQLite write.
- **[Migration v3 on existing DBs]** → `ALTER TABLE analyses ADD COLUMN` is SQLite-safe (no table rebuild). Existing rows get `NULL` for both columns — correctly treated as "unsigned" by the verification logic.
