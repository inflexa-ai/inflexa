## Why

The signed provenance recorder — the machinery that folds harness execution facts into a W3C PROV document (`@inflexa-ai/tsprov`), chain-hashes it, Ed25519-signs it, and persists it whole — lives in the `cli` subsystem, wired to the CLI's event bus, SQLite columns, config-dir keypair, and auth module. A managed embedder that wants the same signed document (Cortex, submitting per-analysis documents to its backend) would have to re-implement all of it, and the two copies would drift — the exact failure mode the harness's seam architecture exists to prevent. The recorder's actual inputs are already harness-owned (`ArtifactRegistrationInput` at the `ArtifactRegistry` seam, `RunProvenanceEvent` from `emitProvenance`), and its host couplings are confined to four narrow points: where snapshots load/persist, how a digest is signed, who the responsible actor is, and how events reach it.

## What Changes

- Add a harness-owned provenance recorder capability under `src/provenance/recorder/`: the PROV document model (deterministic QName derivations, append builders, replay-idempotent merge policy), the recorder lifecycle (per-analysis live documents, coalesced single-flight signed flush, drain), the chain-hash/sign/verify primitives, the sidecar schema, and the two bridges that translate `ArtifactRegistry.register` inputs and `RunProvenanceEvent`s into recorder events.
- Declare the consumer-filled seams: a snapshot sink (`load`/`persist` — the CLI's SQLite columns, a managed host's HTTP backend), a signer (the CLI's config-dir JWK keypair, a managed host's secret-provided key), actor descriptors (user / anonymous / system with label, version, and optional commit), and an injectable QName digest so an embedder with existing documents keeps its identifier space stable.
- Events reach the recorder through a plain `record(event)` call. An event bus may sit in front of it (the CLI's does), but the push seam is a function, accessible to any consumer without a bus.
- The `cli` keeps its bus, its keypair lifecycle, its DB columns, and its actor resolution, and re-wires them onto the extracted capability in a separate change in that subsystem.

## Capabilities

### New Capabilities

- `provenance-recorder`: the signed, chain-hashed PROV document recorder — document model, recorder lifecycle, signing primitives, verification, and the two harness-seam bridges — parameterized over sink, signer, actor, and digest seams.

### Modified Capabilities

None. `exec-provenance-lineage` and the `ArtifactRegistry` seam are unchanged; the recorder consumes their existing shapes.

## Impact

- Additive to the public barrel: `createProvenanceRecorder`, `createProvDocumentModel`, `createProvenanceArtifactRegistry`, `createRunProvenanceEmitter`, the seam types (`ProvSnapshotSink`, `ProvSigner`, `ProvEvent`, `ProvActor`, and the ref types), and the signing/verification primitives. No existing export changes shape.
- Adds `@inflexa-ai/tsprov` to the harness's dependencies.
- No workflow, provider, storage, or DBOS behavior changes. The recorder is inert unless an embedder constructs it and wires its bridges at the composition root.
- The `cli` subsystem's re-wire (deleting its local copies and injecting its bus/SQLite/keypair realizations) is a separate change in `cli/`; until it lands, the CLI continues on its own copy with byte-identical output.
