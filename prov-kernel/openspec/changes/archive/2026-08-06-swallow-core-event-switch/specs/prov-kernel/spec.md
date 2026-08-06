## MODIFIED Requirements

### Requirement: The kernel owns the dialect and nothing else

`@inflexa-ai/prov-kernel` SHALL carry the Inflexa PROV dialect: the document model
(QName derivation, statement builders, unify options, injectable digest), the
core event union `ProvEvent` with its apply function `applyProvEvent`, the
chain-hash and Ed25519 sign/verify primitives, the signed-sidecar schema, and
the actor/ref value types the events carry. The event-to-statements
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
