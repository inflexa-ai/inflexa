# prov-kernel Specification

## Purpose
Define the Inflexa PROV dialect as a standalone package: the document model, the
deterministic identifier scheme, the chain-hash and signature integrity layer,
and the wire-format contract that independent producers implement against.
## Requirements
### Requirement: The kernel owns the dialect and nothing else

`@inflexa-ai/prov-kernel` SHALL carry the Inflexa PROV dialect: the document model
(QName derivation, statement builders, unify options, injectable digest), the
core event union `ProvEvent` with its apply function `applyProvEvent`, the
chain-hash and Ed25519 sign/verify primitives, the signed-attestation schema,
and the actor/ref value types the events carry. The event-to-statements
mapping determines the serialized document bytes, thus the mapping is format
and the kernel SHALL own it for the core events. Core statements SHALL be
producible only through `applyProvEvent`: the per-core-event statement
builders stay off the supported public surface, closing the bypass path that
could produce divergent documents. (The package's `./*` subpath exports mean
a deep import can still reach module internals — the boundary is the
supported type surface, not runtime privacy.) The package SHALL NOT
contain a recorder lifecycle (sink, flush, queue, CAS), signer wiring, or a
harness bridge, and it SHALL NOT depend on `@inflexa-ai/harness`. A host
extension event SHALL stay outside the core union and map onto
`appendLifecycleAction`, the QName derivations, and tsprov interop. The
layering rule is: the harness observes, the kernel represents, hosts decide.

#### Scenario: A host without a harness produces a document

- **GIVEN** a process that depends on `@inflexa-ai/prov-kernel` alone
- **WHEN** it applies core events through `applyProvEvent` and serializes
  under `unified()` with `PROV_UNIFY_OPTIONS`
- **THEN** the result is a valid dialect document, with no harness import
  anywhere in the resolution graph

#### Scenario: The core switch produces the same statements in every host

- **GIVEN** two hosts that deliver the same core event sequence
- **WHEN** each host applies the sequence through `applyProvEvent` against
  `createProvDocumentModel()` and serializes under `unified()`
- **THEN** both documents hold the same statements under the same
  identifiers, and a re-delivered sequence dedupes instead of duplicating

#### Scenario: Extension events stay out of the kernel

- **GIVEN** a host that adds a new observed event kind outside the core union
- **WHEN** it maps the event onto the extension surface, for example through
  the generic `appendLifecycleAction`
- **THEN** the kernel needs no change and no version bump

### Requirement: Identifiers are deterministic and digest-parameterized

Every execution QName and every execution relation identifier SHALL derive
from content through one injected digest function, never from randomness or a
clock. The default digest SHALL be: SHA-256 of the UTF-8 identity string,
first 8 bytes, read big-endian, rendered in base36. Re-building the same
statements SHALL dedupe under `unified()`, and no execution relation SHALL be
anonymous (no `_:` identifier).

#### Scenario: Re-emission dedupes

- **GIVEN** a document that received one run's statements twice
- **WHEN** it serializes under `unified()` with `PROV_UNIFY_OPTIONS`
- **THEN** exactly one entity exists per file key, and exactly one generation
  edge exists under its deterministic relation id

#### Scenario: An injected digest re-keys the identifier space consistently

- **GIVEN** a document model constructed with a custom digest
- **WHEN** it derives file, input, command, and model-agent QNames
- **THEN** every digest-bearing QName differs from the default model's, and
  the same input always derives the same QName within one model

### Requirement: Integrity is a chain hash under an Ed25519 signature

The chain rule SHALL be `H_n = SHA-256(bytes(H_{n-1}) || bytes(json_n))`,
seeded with `SHA-256("")` when no previous hash exists. Signatures SHALL be
Ed25519 over the hex-decoded digest bytes, hex-encoded. The export attestation
SHALL be self-contained (payload digest, signature, and public JWK) and SHALL
validate under `attestationSchema`. The attestation was named the "sidecar"
before version 0.4.0; the object's field names do not carry the old name, thus
existing artifacts verify unchanged. Provenance SHALL never be written or
exported unsigned — every signing failure surfaces as a `ProvSigningError` on
the err channel.

#### Scenario: A correct chain link verifies

- **GIVEN** a stored PROV-JSON, its previous chain hash, its chain hash, and
  a signature by the signer's key
- **WHEN** `verifyProvenance` recomputes the chain and checks the signature
- **THEN** the result is `valid`

#### Scenario: Tampering is detected

- **GIVEN** a payload modified after signing, or a wrong previous hash, or a
  signature over a different digest
- **WHEN** verification runs
- **THEN** the result is `tampered` with a human-readable detail

#### Scenario: An attestation round-trips

- **GIVEN** an attestation built by `buildAttestation` over a payload
- **WHEN** the attestation parses under `attestationSchema` and
  `verifyAttestation` runs against the same payload
- **THEN** the result is `valid`

### Requirement: The wire format is specified for independent implementation

`prov-kernel/SPEC.md` SHALL state the namespace, the digest definition, the QName
format per node kind, the relation-id schemes, the chain rule and its seed,
the signature scheme and encodings, the attestation shape, and the
last-write-wins unify semantics — derived from the code. A committed golden fixture SHALL pin
the serialized bytes of a fully deterministic document, so any conforming
producer can test against it.

#### Scenario: Drift fails the golden test

- **GIVEN** a change that alters a QName derivation, a relation id, an
  attribute name, or the unify policy
- **WHEN** the test suite runs
- **THEN** the golden fixture comparison fails until the fixture is
  regenerated on purpose and `SPEC.md` is updated in the same change

### Requirement: The kernel owns the lineage read model

The kernel SHALL provide the one read-side interpretation of a stored dialect
document. `deriveLineageModel(provJson)` SHALL take the exact stored PROV-JSON
string, unify it under `PROV_UNIFY_OPTIONS`, and return a
`{ nodes, edges }` model: typed, presentation-free nodes (`analysis`, `input`,
and `file` entities, `activity` nodes with the kinds `run`/`step`/`command`/
`file_tool`/`action`, and `agent` nodes with the kinds
`system`/`user`/`model`) and edges for exactly the seven relation kinds
`used`, `generated`, `informed`, `derived`, `attributed`, `associated`, and
`invalidated`. An edge SHALL point in the PROV assertion orientation (formal
argument 0 to formal argument 1) and SHALL carry a deterministic id: the
relation's dialect id when one exists, else the value-derived fallback
`{kind}:{from}->{to}`. A relation endpoint the document never declares SHALL
synthesize a minimal node from its QName; a statement kind outside the seven
SHALL be skipped; bytes that do not parse or unify SHALL return
`err({ type: "prov_corrupt" })`. `computeLineage(model, roots, options)` SHALL
traverse ONLY the `generated` and `used` edges, forward or backward, with a
file-hop `depth` bound of `2n` edges from a file root and `2n - 1` from an
activity root, so a truncation lands on a file node.
`findFileEntity(model, key)` SHALL return the file entity for a
`(path, hash)` key. The read model SHALL NOT touch the write path: the golden
fixture bytes do not change.

#### Scenario: The golden document derives into the shared model

- **GIVEN** the committed golden fixture bytes
- **WHEN** `deriveLineageModel` runs
- **THEN** every declared element is a typed node, every undeclared relation
  endpoint is a synthesized minimal node, and each execution relation keys its
  edge by its deterministic dialect id

#### Scenario: Tolerance for anonymous and unknown statements

- **GIVEN** a document with an anonymous lifecycle relation and a statement
  kind outside the seven
- **WHEN** `deriveLineageModel` runs
- **THEN** the anonymous relation gets the value-derived fallback id, and the
  unknown statement kind is skipped with no error

#### Scenario: The walk traverses only generation and usage

- **GIVEN** a derived model of a produced file
- **WHEN** `computeLineage` walks backward from the file
- **THEN** the result holds the file-to-command-to-input chain, and the
  analysis entity, the run spine, and the agents stay out

#### Scenario: Depth counts file hops and truncates on a file node

- **GIVEN** a chain of two commands between three files
- **WHEN** `computeLineage` walks backward from the last file with depth 1
- **THEN** the result ends at the intermediate file, and the earlier command
  and its inputs stay out
