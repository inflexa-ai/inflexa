## 1. Document model

- [x] 1.1 Port the provenance domain types (`ProvActor` with the generalized `system` variant, `ProvModelId`, the input/run/step/file/command refs, `VerifyResult`) into `src/provenance/recorder/types.ts`, plus the harness-owned `ProvEvent` union.
- [x] 1.2 Port `document.ts` as `createProvDocumentModel({ digest?, mintActionId? })` — QName derivations, append builders, `PROV_UNIFY_OPTIONS`, `freshDocument`/`loadDocument` over a plain subject value — with a Node-portable default digest.
- [x] 1.3 Port the document-model tests against the default digest, plus a test proving an injected digest changes every derived QName consistently (bridge `externalId` included).

## 2. Signing primitives and verification

- [x] 2.1 Port `computeChainHash`, `computePayloadDigest`, `signHexDigest`, `verifyHexDigest`, and the hex helpers into `src/provenance/recorder/signing.ts`; declare `ProvSigner` and `ProvSigningError`.
- [x] 2.2 Port the sidecar schema and the two verification entry points (chained stored-document verify, self-contained sidecar verify) into `src/provenance/recorder/verify.ts`, parameterized on stored values.
- [x] 2.3 Port the signing/verify tests with an in-memory keypair.

## 3. Recorder lifecycle

- [x] 3.1 Implement `createProvenanceRecorder({ sink, signer, documentModel?, logger? })` with per-instance state: async first-touch load with event queueing, revision-guarded dirty tracking, coalesced single-flight signed flush, chain-conflict refresh, and a `flush()` drain with the no-progress guard.
- [x] 3.2 Declare `ProvSnapshotSink` (`load` → seed-or-null, `persist` with optional `conflict` rejection) and the snapshot value types.
- [x] 3.3 Port the recorder tests onto a fake sink/signer: burst coalescing, mid-flush append survival, signed-only persistence, corrupt-stored-document fresh start, unknown-analysis skip, conflict refresh, drain-to-quiescence and no-progress stop.

## 4. Bridges

- [x] 4.1 Port `createProvenanceArtifactRegistry({ emit, actor, model, documentModel })` — producer grouping, leaf partition, self-read resolution, attestation fail-fast, `externalId` from the model's `fileQName`.
- [x] 4.2 Port `createRunProvenanceEmitter({ emit, actor, model })` mapping the three `RunProvenanceEvent` arms.
- [x] 4.3 Port the bridge tests (grouping, scoping, hash-less failure, `source: "step"` resolution, event ordering).

## 5. Surface and hygiene

- [x] 5.1 Add `@inflexa-ai/tsprov` to `package.json` dependencies.
- [x] 5.2 Export the factories, seam types, event/actor/ref types, and signing primitives from the barrel.
- [x] 5.3 `tsc -p tsconfig.json`, `bun test`, lint, `bun run format:file` on touched sources.
