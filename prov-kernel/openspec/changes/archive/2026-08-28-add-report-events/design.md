# Design

## Context

The cli records nine session and report acts on the analysis document today.
The mapping lives in the cli (`cli/src/modules/prov/prov.ts:142-352`), rides
the `appendLifecycleAction` extension door, and restates the internal
`appendModelAgent`. The kernel spec currently keeps a host event out of the
core union. The review of inflexa PR #467 rejects that split for this family:
the mapping determines the document bytes, thus it is format, and the kernel
owns format.

## Goals / Non-Goals

**Goals:**

- One core union carries the execution family, the lifecycle family, and the
  session and report family.
- The document bytes stay identical to what the cli mapping writes today.
- The double-emit race on the report entity closes inside the kernel.

**Non-Goals:**

- No recorder lifecycle, no signer wiring, and no harness bridge enter the
  kernel.
- No change to the execution family, to the chain rule, or to the attestation
  shape.
- No removal of the extension door. A host-specific event still maps onto it.

## Decisions

### D1 — the family is core, not extension

The nine members join `ProvEvent`, and `applyProvEvent` maps them. The
alternative keeps the mapping host-side, but that forces every host to restate
kernel internals, and the `appendModelAgent` copy in the cli is the proof. A
copy does not break at compile time when the kernel changes.

### D2 — the family keeps the lifecycle shape

Each act mints one typed action activity through `appendLifecycleAction`. The
act data lands as attributes in a second declaration of that activity. The
second declaration carries no formal time. The execution-style deterministic
ids are the alternative. But the acts emit one time from a live bus, never
from a durable replay, and the historical bytes use minted ids.

### D3 — byte continuity with the historical mapping

The builders keep each QName, each activity type, and each attribute of the
cli mapping: `inflexa:report-{digest(threadId)}`,
`inflexa:report-version-{digest(versionId)}`, the nine activity types, and the
attribute names. The model runs over the injected digest
(`cli/src/modules/prov/document.ts:29`), thus the QNames match without extra
work. A new vocabulary is the alternative, but existing signed documents must
keep merging and verifying.

### D4 — first-declaration guards on the minted entities

tsprov gives `specializationOf` no identifier, thus `unified()` cannot
collapse a second copy. The version arm guards it today
(`cli/src/modules/prov/prov.ts:330`). The kernel arms guard the generation
edge, the attribution, and the specialization of both minted entities on the
first declaration. This also closes the `prepareChatTurn` double-emit race
(`harness/src/app/chat-turn.ts:69-100`).

### D5 — the block kind rides the act

The four block members carry `blockKind`, stamped as `inflexa:blockKind` on
the action activity. The kind is the kind that the document holds after the
act. This is a new attribute, thus it changes no existing bytes.

### D6 — an additive minor version

The union grows, and no existing member changes. A producer compiles
unchanged. The version moves to `0.6.0`, and the cli pin moves with it.

## Risks / Trade-offs

- [The golden fixture churns] → Extend the fixture document with the new
  members on purpose, and update `SPEC.md` in the same change.
- [A byte drift against the historical mapping forks the identifier space] →
  Port the builders one-for-one. The cli keeps its `kernel_compat` guard at
  the consumer side.
- [Minted action ids resist a deterministic fixture] → The fixture model
  injects a fixed mint function, the pattern the golden document uses today.

## Migration Plan

No runtime migration. A document is append-only, and an old document with no
report records stays valid. The cli deletes its host mapping in its own
change, after the version bump lands.

## Open Questions

None.
