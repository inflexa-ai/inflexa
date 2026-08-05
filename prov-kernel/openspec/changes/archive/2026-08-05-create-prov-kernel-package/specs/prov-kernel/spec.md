## ADDED Requirements

### Requirement: The kernel owns the dialect and nothing else

`@inflexa-ai/prov-kernel` SHALL carry the Inflexa PROV dialect: the document model
(QName derivation, statement builders, unify options, injectable digest), the
chain-hash and Ed25519 sign/verify primitives, the signed-sidecar schema, and
the actor/ref value types the builders accept. The package SHALL NOT contain
an event union, an event reducer, a recorder lifecycle (sink, flush, queue,
CAS), or a harness bridge, and it SHALL NOT depend on `@inflexa-ai/harness`.
The layering rule is: the harness observes, the kernel represents, hosts
decide.

#### Scenario: A host without a harness produces a document

- **GIVEN** a process that depends on `@inflexa-ai/prov-kernel` alone
- **WHEN** it builds a document through the statement builders and serializes
  under `unified()` with `PROV_UNIFY_OPTIONS`
- **THEN** the result is a valid dialect document, with no harness import
  anywhere in the resolution graph

#### Scenario: Host events stay out of the kernel

- **GIVEN** a host that adds a new observed event kind
- **WHEN** it maps the event onto the existing builders
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
Ed25519 over the hex-decoded digest bytes, hex-encoded. The export sidecar
SHALL be self-contained (payload digest, signature, and public JWK) and SHALL
validate under `sidecarSchema`. Provenance SHALL never be written or exported
unsigned — every signing failure surfaces as a `ProvSigningError` on the err
channel.

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

#### Scenario: A sidecar round-trips

- **GIVEN** a sidecar built by `buildSidecar` over a payload
- **WHEN** the sidecar parses under `sidecarSchema` and `verifySidecar` runs
  against the same payload
- **THEN** the result is `valid`

### Requirement: The wire format is specified for independent implementation

`prov-kernel/SPEC.md` SHALL state the namespace, the digest definition, the QName
format per node kind, the relation-id schemes, the chain rule and its seed,
the signature scheme and encodings, the sidecar shape, and the last-write-wins
unify semantics — derived from the code. A committed golden fixture SHALL pin
the serialized bytes of a fully deterministic document, so any conforming
producer can test against it.

#### Scenario: Drift fails the golden test

- **GIVEN** a change that alters a QName derivation, a relation id, an
  attribute name, or the unify policy
- **WHEN** the test suite runs
- **THEN** the golden fixture comparison fails until the fixture is
  regenerated on purpose and `SPEC.md` is updated in the same change
