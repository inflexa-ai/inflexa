## MODIFIED Requirements

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
last-write-wins unify semantics — derived from the code. A committed golden
fixture SHALL pin the serialized bytes of a fully deterministic document, so
any conforming producer can test against it.

#### Scenario: Drift fails the golden test

- **GIVEN** a change that alters a QName derivation, a relation id, an
  attribute name, or the unify policy
- **WHEN** the test suite runs
- **THEN** the golden fixture comparison fails until the fixture is
  regenerated on purpose and `SPEC.md` is updated in the same change
