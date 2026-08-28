# prov-kernel — delta

## MODIFIED Requirements

### Requirement: The kernel owns the dialect and nothing else

`@inflexa-ai/prov-kernel` MUST carry the Inflexa PROV dialect, and nothing
else. The dialect covers:

- the document model: the QName derivation, the statement builders, the unify
  options, and the injectable digest
- the core event union `ProvEvent` with its apply function `applyProvEvent`
- the chain-hash and Ed25519 signature primitives
- the signed-attestation schema
- the actor and ref value types that the events carry

The core union covers three families: the execution family, the lifecycle
family, and the session and report family. The event-to-statements mapping
determines the serialized document bytes. Thus the mapping is format, and the
kernel MUST own it for the core events. Core statements MUST be producible
only through `applyProvEvent`. The per-core-event statement builders stay off
the supported public surface, which closes the bypass path to a divergent
document.

(The `./*` subpath exports let a deep import reach module internals
— the boundary is the supported type surface, not runtime privacy.) The
package MUST NOT contain a recorder lifecycle (sink, flush, queue, CAS),
signer wiring, or a harness bridge, and it MUST NOT depend on
`@inflexa-ai/harness`. A host-specific extension event MUST stay outside the
core union, and it maps onto `appendLifecycleAction`, the QName derivations,
and tsprov interop. The layering rule is: the harness observes, the kernel
represents, hosts decide.

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

- **GIVEN** a host that adds an observed event kind that only that host
  records
- **WHEN** it maps the event onto the extension surface, for example through
  the generic `appendLifecycleAction`
- **THEN** the kernel needs no change and no version bump

### Requirement: The kernel owns the lineage read model

The kernel MUST give the one read-side interpretation of a stored dialect
document. This delta changes one piece: the typed entity node kinds. The
entity kinds cover `analysis`, `input`, `file`, `report`, and
`report_version`. A report entity types as `report`, and a version entity
types as `report_version`, never through the `file` fallback. The rest of the
requirement does not change.

#### Scenario: A report entity types as a report

- **GIVEN** a document with a report entity and a version entity
- **WHEN** `deriveLineageModel` runs
- **THEN** the report node carries the kind `report`, the version node
  carries the kind `report_version`, and `findFileEntity` returns neither

## ADDED Requirements

### Requirement: The session and report family is core format

The core union MUST carry nine session and report members: `session_created`,
`report_block_added`, `report_block_changed`, `report_block_removed`,
`report_block_moved`, `report_title_set`, `report_derivation_run`,
`report_previewed`, and `report_version_recorded`. Each member maps onto one
typed action activity in the lifecycle shape, with the act data as
attributes. Each member names the model that drove the act. The mapping
records the model agent, its delegation to the responsible agent, and its
association with the activity. The four block members MUST carry `blockKind`,
stamped as `inflexa:blockKind` on the action activity.

A `session_created` member of kind `report` mints the report entity. A
`session_created` member of kind `conversation` mints no entity, because a
conversation is the session alone. A `report_version_recorded` member mints
the version entity and its specialization of the report. The generation edge,
the attribution, and the specialization of a minted entity MUST land only on
the first declaration of that entity.

The statements MUST stay byte-identical to the historical host mapping of the
cli, under the same injected digest. `SPEC.md` MUST state the report
vocabulary, and the golden fixture MUST cover the nine members.

#### Scenario: A double emit adds no second generation edge

- **GIVEN** a document that received one `session_created` of kind `report`
  twice for one thread
- **WHEN** it serializes under `unified()` with `PROV_UNIFY_OPTIONS`
- **THEN** the report entity carries one generation edge and one attribution

#### Scenario: A version is a specialization of its report

- **GIVEN** a document with a `session_created` of kind `report` and a
  `report_version_recorded` for the same thread
- **WHEN** it serializes under `unified()`
- **THEN** the version entity carries exactly one `specializationOf` edge to
  the report entity, also when the version member arrived twice

#### Scenario: A block act names its kind

- **WHEN** `applyProvEvent` maps a `report_block_added` with `blockKind`
  `chart`
- **THEN** the action activity carries `inflexa:blockKind` with the value
  `chart`

#### Scenario: A late act mints the report entity lazily

- **GIVEN** a document that received a `report_block_added` and no
  `session_created`
- **WHEN** the arm maps the act
- **THEN** the report entity exists with no parent attribute, and the act
  holds a `used` edge to it
