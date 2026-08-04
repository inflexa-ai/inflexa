# Design — extracting the provenance recorder into the harness

## The cut

The CLI recorder decomposes into a generic core and exactly four host couplings. The core moves; each coupling becomes a seam the embedder fills at its composition root:

| Seam | CLI realization | Managed realization (reference) |
|-|-|-|
| `ProvSnapshotSink` — `load(analysisId)` / `persist(snapshot)` | SQLite `analyses.provenance` + integrity columns | GET/PUT against the backend's document endpoint |
| `ProvSigner` — `sign(digestHex)` | `~/.config/inflexa/prov_key.json`, generate-on-first-use | Ed25519 JWK from a mounted secret |
| `ProvActor` values on each event | `loadAuth()` email / CLI version + baked commit | session identity / service name + version |
| QName digest (`createProvDocumentModel({ digest })`) | `Bun.hash` (keeps existing documents' QNames stable) | harness default (`node:crypto` SHA-256 fold) |

The event feed is deliberately **not** a seam interface: `ProvenanceRecorder.record(event)` is a plain synchronous function. The CLI keeps its bus and subscribes `record` to it; a managed host calls `record` directly from the two bridges. A bus is one delivery mechanism, not part of the contract.

## Document model as a factory

`document.ts`'s builders were module-level functions closing over `Bun.hash` and `randomUUIDv7`. Both are runtime-coupled (the harness runs on Node) and the digest is identity-load-bearing: every file/command/agent QName embeds it, so changing the function would orphan the QName space of every existing CLI document — re-emission after an upgrade would mint new identifiers for the same files and `unified()` would keep both. `createProvDocumentModel({ digest?, mintActionId? })` makes the derivation explicit and injectable: the harness default is a Node-portable SHA-256 fold; the CLI injects its `Bun.hash` wrapper and its documents stay continuous. The bridges take the same model instance so the `externalId` a registration returns is minted by the same derivation the recorder appends with.

No ambient state anywhere: the recorder is a factory instance (per-instance live-doc/chain/dirty maps), so tests construct fresh instances instead of resetting module globals.

## Recorder lifecycle changes vs the CLI copy

Two deliberate deltas; everything else (revision-guarded dirty tracking, coalesced timer flush, single-flight chain discipline, signed-only persistence, no-progress drain guard) ports as-is:

1. **First-touch load is async.** The CLI's sink is synchronous SQLite; a managed sink is an HTTP round-trip. `record()` stays synchronous fire-and-forget: the first event for an analysis starts the sink load and queues events; when the load settles the queue drains into the (deserialized or fresh) document and the analysis is marked dirty. A failed load or unknown analysis (`load → ok(null)`) drops the queued events with a logged error/warn — recording must never block or fail the emitting execution path, exactly as the CLI's builder-throw guard already establishes.
2. **Chain-conflict recovery.** The sink may reject a persist with `{ type: "conflict" }` (a compare-and-swap on `prevChainHash`, for sinks that support it). The recorder then refreshes its cached chain head from `sink.load` and retries on the next flush — the chain never forks. Content-level merge of concurrent writers is out of scope: the recorder documents a **single-writer-per-analysis** requirement (the CLI holds an analysis lock; a managed host's workflow ownership provides the same), and the CAS exists to detect violations, not to reconcile them.

## Signing split

The pure primitives (chain hash `SHA-256(prev || json)` with the `SHA-256("")` seed, payload digest, hex Ed25519 sign/verify) move into the harness — they are WebCrypto-only and shared by recorder, sidecar export, and verification. The **keypair lifecycle** (where a key lives, generate-on-first-use, exclusive-create race handling) stays host-side behind `ProvSigner`: key custody is a policy decision the harness must not make. The sidecar schema and the two verification entry points (chained column verify, self-contained sidecar verify) move, parameterized on stored values rather than on any database.

## Actor generalization

The CLI's `system` actor hardcoded the label "inflexa cli". The harness shape carries the host's own identity — `{ kind: "system"; label; version; commit? }` — so a managed host records its service name and build, and the CLI passes its label and stays byte-identical. `user`/`anonymous` are unchanged. The model agent (`ProvModelId`, `{provider}/{model}`) is unchanged and remains per-event, so live model swaps keep working through the CLI's existing swappable wrapper composed over the extracted bridge constructors.

## What deliberately does not move

- The CLI's bus stamping, analysis-ref resolution for `prov` commands, export file layout, and keypair file handling — host policy.
- `SwappableSandboxEmitters` — a CLI composition detail over the bridge constructors.
- Any change to `ArtifactRegistry`, `emitProvenance`, or `exec-provenance-lineage` — the recorder consumes their existing shapes.
