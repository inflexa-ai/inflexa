## ADDED Requirements

### Requirement: The recorder is a harness factory over consumer-filled seams

`createProvenanceRecorder({ sink, signer, documentModel?, logger? })` SHALL construct a provenance recorder whose only host contact points are the injected `ProvSnapshotSink` (snapshot load/persist), `ProvSigner` (digest signing), and the `ProvActor`/model values carried on each event. All recorder state (live documents, chain heads, dirty tracking) SHALL be per-instance — no module-level state. Events SHALL be delivered through the plain synchronous call `record(event: ProvEvent)`; a delivery mechanism such as an event bus MAY sit in front of it but is not part of the contract.

#### Scenario: Two recorder instances are independent

- **WHEN** two recorders are constructed over different sinks and each records events for the same analysis id
- **THEN** each persists through its own sink with its own chain, and neither observes the other's state

#### Scenario: A consumer without a bus records directly

- **WHEN** a host calls `record(event)` from its own call sites with no event bus anywhere
- **THEN** the event is appended and flushed exactly as it would be behind a bus subscription

### Requirement: Provenance is never persisted unsigned and the chain never forks

Every persisted snapshot SHALL be the whole serialized document (unified last-write-wins), chain-hashed as `SHA-256(prevChainHash || documentJson)` seeded from `SHA-256("")`, and signed via the injected `ProvSigner` before it reaches the sink. A signing or persist failure SHALL leave the analysis dirty for retry and SHALL NOT write unsigned bytes. Flushing SHALL be single-flight per recorder instance, and per-analysis snapshots SHALL be captured synchronously so an append landing mid-flush survives to the next pass (revision guard). `flush()` SHALL drain to quiescence and stop on a pass that makes no progress.

#### Scenario: Signing failure retains the tail

- **WHEN** the signer rejects during a flush and a later append arrives
- **THEN** no unsigned snapshot is persisted, the analysis remains dirty, and the next flush persists a signed snapshot containing both the earlier and the later records

#### Scenario: Append during flush is not swallowed

- **WHEN** an event is recorded after a flush pass has serialized an analysis's snapshot but before its persist settles
- **THEN** the analysis remains dirty and a subsequent pass persists the tail

### Requirement: First-touch load is asynchronous and never blocks the emitter

On the first event for an analysis, the recorder SHALL start `sink.load(analysisId)` and queue events for that analysis; `record` SHALL return without awaiting. When the load resolves, a stored document SHALL be deserialized (its chain head adopted) or a fresh document seeded from the returned subject, and the queue drained into it. A load returning `null` (unknown analysis) SHALL drop the queued events with a warning; a load failure or corrupt stored document SHALL start a fresh document and chain with a logged error. A builder failure while appending one event SHALL drop that event only.

#### Scenario: Events queued during load are recorded in order

- **WHEN** three events are recorded while the sink load for their analysis is in flight
- **THEN** after the load resolves all three are appended in arrival order and one flush persists them

#### Scenario: Unknown analysis is skipped

- **WHEN** `sink.load` resolves `null` for an analysis id
- **THEN** its queued events are dropped with a warning and nothing is persisted for it

### Requirement: Single writer per analysis, conflict detected via the sink

The recorder SHALL assume one writer per analysis document (the embedder guarantees it — an analysis lock, workflow ownership, or equivalent). A sink whose `persist` supports compare-and-swap on `prevChainHash` SHALL reject a stale write with a `conflict` error; the recorder SHALL respond by refreshing its cached chain head from `sink.load` and retrying on a later flush, so the chain never forks. Content-level reconciliation of concurrent writers is out of scope.

#### Scenario: Conflict refreshes the chain head

- **WHEN** `persist` rejects with `conflict` and the stored chain head has advanced
- **THEN** the recorder re-reads the head and the next flush persists chained onto it

### Requirement: Deterministic identifiers with an injectable digest

`createProvDocumentModel({ digest?, mintActionId? })` SHALL derive every execution QName and relation identifier deterministically from domain tuples (file `(path, hash)`, command output sets, agent identity), so DBOS re-execution re-emits identical records that `unified()` collapses. The digest function SHALL be injectable so an embedder with existing documents keeps its identifier space stable; the default SHALL be Node-portable. The bridges SHALL mint `externalId` values through the same model instance, so a registration's returned identifiers always match the recorded document.

#### Scenario: Replay re-emission dedupes

- **WHEN** the same execution events are recorded twice (a workflow re-execution) into one document
- **THEN** the unified serialized document contains one record per QName with no duplicated relations

#### Scenario: Injected digest keeps an existing QName space

- **WHEN** a document model is constructed with a custom digest matching a prior producer
- **THEN** the same file `(path, hash)` derives the same QName the prior producer minted, and `externalId` values match it

### Requirement: The bridges translate the two harness seams into recorder events

`createProvenanceArtifactRegistry({ emit, actor, model, documentModel })` SHALL realize `ArtifactRegistry`: partition manifest entries by their collector record's producer into command groups and a leaf bucket, emit one `command_executed` per group followed by its `file_written` events (`generation: "command"`), leaf `file_written` events (`generation: "step"`), and one `input_used` per tracked non-`artifacts` read; return each file's model-derived QName as `externalId`; report hash-less entries and hash-less input refs in `failed` (fail-fast attestation); resolve a step's own `artifacts` reads to `source: "step"` command inputs keyed on the surviving registered hash; and keep `sync` a no-op. `createRunProvenanceEmitter({ emit, actor, model })` SHALL map the three `RunProvenanceEvent` arms onto `run_started`/`step_completed`/`run_completed` events, passing checkpointed timestamps through unchanged and never reading a clock.

#### Scenario: Producer group emits declaration before reference

- **WHEN** a registration carries two entries produced by one command and one leaf entry
- **THEN** the emitted order is the command's `command_executed`, its two `file_written` events with `generation: "command"`, then the leaf's `file_written` with `generation: "step"`, and `registered` carries three model-derived QNames

#### Scenario: Missing hash fails the registration entry

- **WHEN** a manifest entry or tracked input ref arrives without a content hash
- **THEN** it is reported in `failed` (failing the step upstream) and no event is emitted for it

### Requirement: Verification is exposed for stored and exported documents

The harness SHALL export the chain/payload digest and Ed25519 hex sign/verify primitives, the export sidecar schema (`payloadType`, `payloadDigestAlgorithm`, `payloadDigest`, `payloadDigestMethod`, `signatureAlgorithm`, `signature`, `publicKey`), and two verification entry points parameterized on stored values: chained verification (recompute `SHA-256(prev || json)`, verify the signature over it) and self-contained sidecar verification (recompute `SHA-256(bytes)`, verify). Outcomes SHALL use the `VerifyResult` vocabulary (`valid`/`unsigned`/`tampered`/`no-key`/`empty`/`invalid-sidecar`/`invalid-key`/`verify-error`).

#### Scenario: Tampered stored document fails chained verification

- **WHEN** a stored document's bytes are altered after signing
- **THEN** chained verification returns `tampered` with detail

#### Scenario: Sidecar verifies without the keypair file

- **WHEN** a sidecar carries the public key JWK and a matching signature over the payload digest
- **THEN** sidecar verification returns `valid` using only the sidecar and payload bytes
