# Research brief: embedding cryptographic signatures in W3C PROV documents

## Context

We have a local CLI tool (inflexa) that records W3C PROV-DM provenance documents for data analysis workflows, serialized as PROV-JSON via the `@inflexa-ai/tsprov` TypeScript library. We've implemented tamper-evidence using Ed25519 signatures over SHA-256 chain hashes, currently stored as separate database columns alongside the PROV-JSON blob.

We're considering embedding the signature directly into the PROV document itself (at export time), so the exported artifact is self-contained and independently verifiable without a sidecar file.

## What we want to know

### 1. Precedent in the W3C PROV ecosystem

- Does the W3C PROV family of specs (PROV-DM, PROV-O, PROV-N, PROV-CONSTRAINTS, PROV-AQ) address digital signatures or document integrity?
- Are there any W3C Notes, community reports, or reference implementations that embed signatures in PROV documents?
- How does PROV-AQ (provenance access and query) handle authentication and integrity of provenance records retrieved from remote sources?

### 2. The Bundle pattern for provenance-of-provenance

- PROV-DM defines `prov:Bundle` as a named set of provenance records that can itself be an entity with its own provenance. Is the canonical pattern for signing a PROV document: (a) place the actual provenance records in a named bundle, (b) in the outer document, create a signature entity that `wasGeneratedBy` a signing activity, carrying the hash and signature as attributes?
- Are there published examples of this pattern (academic papers, reference implementations, tooling)?
- Does this pattern have a name in the literature (e.g., "provenance of provenance," "meta-provenance," "signed bundles")?

### 3. The deterministic serialization problem

- To sign a PROV document, we need to hash its serialization. To verify, we need to re-serialize and get the same bytes. Does PROV-JSON (the JSON serialization of PROV-DM) have a canonical/deterministic form?
- If not, how do existing implementations handle this? Options we're aware of: (a) JCS (JSON Canonicalization Scheme, RFC 8785), (b) sign the inner bundle's serialization and store the signed bytes verbatim (verify by extracting and comparing, not re-serializing), (c) sign a content-addressed hash of the semantic content rather than the serialization.
- Are there parallels from other signed-JSON ecosystems (JSON-LD Signatures / Linked Data Proofs, JWT/JWS, COSE Sign1) that have solved this for RDF or JSON documents?

### 4. Linked Data Proofs / Verifiable Credentials overlap

- The W3C Verifiable Credentials (VC) spec embeds proofs (signatures) directly in JSON-LD documents. PROV-O is an OWL ontology with a JSON-LD serialization. Is there precedent for applying VC-style proofs to PROV-O documents?
- The `@digitalbazaar/jsonld-signatures` and `@transmute/linked-data-proof` libraries implement Linked Data Proofs. Could these be applied to PROV-JSON (which is not JSON-LD but is structurally similar)?
- Is there a simpler path that avoids the full LD Proofs machinery?

### 5. Best practices for signed provenance in practice

- How do production systems that care about provenance integrity handle signing? Specifically:
  - **in-toto** (software supply chain attestations): uses an "envelope" format (DSSE — Dead Simple Signing Envelope) that wraps the payload. How does this relate to embedding vs. enveloping?
  - **SLSA** (Supply-chain Levels for Software Artifacts): builds on in-toto. Does it embed signatures in provenance or use envelopes?
  - **Sigstore**: signs and stores attestations. What's the signature embedding pattern?
  - **Arweave / IPFS provenance**: content-addressed storage where the hash IS the identifier. Does this obviate the need for embedded signatures?
- Is the industry consensus "embed" or "envelope" (signature wraps the document) or "detached" (signature is a separate artifact)?

### 6. Our specific design question

Our current approach: PROV-JSON is stored in the database as a plain blob. At export time, we write a sidecar `.sig.json` file alongside the PROV file, containing `{ chainHash, signature, publicKey }`.

The alternative we're considering: at export time, wrap the PROV records in a `prov:Bundle`, add a signature entity to the outer document with the hash, signature, and public key as attributes, and export the whole thing as a single self-contained PROV-JSON file.

Questions for the research:
- Is the bundle-wrapping approach sound, or is there a better PROV-native pattern?
- Should we use the DSSE envelope pattern instead (not PROV-native, but widely adopted in supply chain security)?
- Is there a risk that embedding the signature in the PROV document makes it harder for standard PROV tools to consume the document (vs. a detached/sidecar approach that leaves the PROV file untouched)?
- What do we lose by NOT embedding (i.e., keeping the sidecar approach)?

## Constraints

- We use TypeScript (Bun runtime) and the `@inflexa-ai/tsprov` library (a TypeScript port of the Python `prov` library).
- tsprov supports PROV-JSON and PROV-N serialization, `prov:Bundle`, and the full PROV-DM relation set.
- We sign with Ed25519 via WebCrypto (no external dependencies).
- This is a local CLI tool, not a distributed system — the threat model is "detect tampering after the fact," not "prevent a malicious server from serving forged provenance."
- We do NOT need to support re-importing externally-modified PROV documents. If someone modifies an exported document, the signature is expected to invalidate — that's correct behavior.

## Desired output

A report covering the questions above with:
- Concrete references (spec sections, paper titles, library names, GitHub repos)
- A recommendation for our specific case (embed via bundle, DSSE envelope, or keep sidecar)
- Any gotchas or risks we should know about before committing to a direction
