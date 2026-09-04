# Design

## Context

The host lookup folds each request with `canonicalDistributionName`
(`src/modules/libs/composition.ts:583`), and it reads `by_name` of each
track under that key (`composition.ts:540-551`). The spec
`farm-composition` requires the fold as the one lookup identity, for both
tracks. The companion harness change keys the R track by the DESCRIPTION
spelling. Thus the host must read the R track by that spelling, or every R
lookup misses.

The harness design of `package-name-resolution` records the decisions
D1 to D8. This design records only the host parts.

## Goals / Non-Goals

**Goals:**

- The host resolves a name by the identity rule of the track it reads.
- An unqualified request follows one precedence ladder, and the ladder
  never picks Python first in silence.
- A graph of the wrong version stops with the remedy.

**Non-Goals:**

- The flight key stays canonical (`store_flight.ts:103-105`). A flight
  carries the ecosystem, thus the fold cannot cross a track there.
- `store ls` and the sidebar stay as they are. They print the pin marker,
  which carries the exact spelling already.
- The `--lang` flag of `store link` and `store add` stays as it is.

## Decisions

### D1. The ladder, as the host runs it

`resolvePackageRequest` reads the two shelves with `shelfKey` from the
harness. The Python shelf key is the fold of the request. The R shelf key
is the request verbatim.

1. The request names an ecosystem: that shelf only. A miss on the R shelf
   still gives the suggestion of step 6.
2. The R shelf holds the key, and the request is not equal to its own
   fold: R.
3. The R shelf holds the key, and the Python shelf holds the fold:
   `ambiguous_ecosystem`, with the two head directories.
4. The R shelf holds the key: R. An R name that is its own fold, such as
   `dplyr`, reaches its package here, and no earlier step can take it.
5. The Python shelf holds the fold: Python.
6. Exactly one R key folds to the fold of the request:
   `unknown_distribution`, with that key as `suggestion`.
7. Otherwise `unknown_distribution` with no suggestion.

Step 2 before step 3 is the whole point. Without it, `decoupleR` folds to
`decoupler`, the Python shelf holds `decoupler`, and the ladder refuses
the exact R spelling as ambiguous.

Alternative: fold the request for the R shelf too, with an
unambiguous-fold rule. That fold hides a graph of version 1 behind a
reader of version 2, because the old lowercase key answers the folded
request. The version gate must see the miss.

### D2. The suggestion rides in the error, not in a second lookup

`unknown_distribution` gains an optional `suggestion`. The refusal text
of `store link` and the `absent` outcome of the seam render it. The
harness link pass renders the outcome as it does today, thus the
suggestion reaches the launch refusal through the `detail` of the
`absent` outcome.

### D3. The seam names the track of each collision candidate

The `collision` outcome of a two-track hit carries a `detail` that names
the track of each store directory. The harness composes the launch
refusal from the outcome, and it cannot tell the Python directory from
the R directory by the name alone: `decoupler-2.2.0-<hash>` and
`decoupler-2.17.0-<hash>` differ only in the version.

### D4. The reader binds to graph version 2

`GRAPH_VERSION` becomes 2. The `graph_unusable` render for a version
mismatch names the remedy by direction: a lower version on disk names
`inflexa store download --update`, and a higher version on disk names a
host upgrade.

The acquisition commit reads the two shelves too, thus it refuses a graph
of another version with the same two remedies. Its own refusal is a commit
refusal, because the commit holds the store lock and it writes nothing.

### D5. One shelf-key rule, imported

`composition.ts` and `store_flight.ts` import `shelfKey` from
`@inflexa-ai/harness`. `canonicalDistributionName` stays for the flight
key and for the Python shelf. The R edge resolution of the acquisition
commit (`store_flight.ts:326`) reads `shelfKey(node.track, edge)`.

## Risks / Trade-offs

- [`store link seurat` stops] → the refusal names `Seurat`. The scenario
  "A lookup matches every spelling" of `farm-composition` becomes "A
  folded R spelling is a suggestion".
- [A user with a version-1 store and this host] → each store command and
  each launch refuses with the update remedy until the update lands.
- [The composition fixtures key `by_name.r` in lower case] → the fixtures
  move to the exact spelling, and the version field moves to 2.
- [The harness export] → this change compiles only against a harness that
  exports `shelfKey`. `bun run harness:local` links the working copy.

## Migration Plan

- The reader accepts version 2 only. A version-1 store on disk refuses
  each store command and each launch with the update remedy, until
  `inflexa store download --update` replaces it.
- A rollback of this change gives a reader of version 1. Against a
  version-2 store it refuses with the version reason.

## Open Questions

None.
