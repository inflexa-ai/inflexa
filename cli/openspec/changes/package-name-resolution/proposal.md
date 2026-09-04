# Package name resolution: the host lookup obeys the identity rule of each track

## Why

A launch refused a plan because the pool holds the Python distribution
`decoupler` and the R package `decoupleR`. The graph keys both under one
folded name, and the host lookup finds the key in both tracks. The cli
spec `farm-composition` requires that fold today, thus this change is a
spec change and not a fix. The companion harness change
`package-name-resolution` moves the graph to one identity rule for each
track, and it gives a plan the ecosystem prefix. This change connects the
host: the lookup, the pool inventory, the acquisition commit, and the
graph-version remedy.

## What Changes

- The lookup identity of an R package is its DESCRIPTION spelling, and the
  lookup identity of a Python distribution is its PEP 503 form. The
  canonical form no longer serves as the identity of an R name.
  **BREAKING**: `inflexa store link seurat` no longer resolves `Seurat`.
  The refusal names `Seurat` as the suggestion.
- An unqualified request resolves by a precedence ladder. An exact R hit
  that is not in its own folded form wins. An exact R hit beside a Python
  hit is ambiguous. A Python hit wins otherwise. A single folded R hit is
  a suggestion inside an unknown-distribution refusal.
- The host reads graph version 2 only. A graph of another version refuses
  as `graph_unusable`, and the refusal names `inflexa store download
  --update` as the remedy.
- The acquisition commit resolves a bare R edge by the exact name, with
  the shelf-key rule that the harness exports.
- The launch refusal and the `store link` refusal for a two-track
  collision name the two prefixed forms, `python:<name>` and `r:<name>`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `farm-composition`: the identity rule is per track, the resolution obeys
  the precedence ladder, and a folded R hit is a suggestion.
- `package-store-management`: the launch refusal for a two-track collision
  names the prefixed forms.

## Impact

- `src/modules/libs/composition.ts`: `resolvePackageRequest`,
  `GRAPH_VERSION`, `describeFarmCompositionError`, and the removal of the
  local fold in favor of the harness `shelfKey`.
- `src/modules/libs/store_flight.ts`: the bare-edge resolution of the
  acquisition commit, and the graph version that the commit accepts.
- `src/modules/harness/runtime.ts`: the launch remedy of a pool miss. It
  names the suggestion before the store-add ask.
- `src/modules/libs/packages.ts`: no code change. The inventory publishes
  the node name, and the node name becomes the exact spelling.
- `src/modules/libs/store.ts`: the refusal text of `store link`.
- The fixtures that key `by_name.r` in lower case move to the exact
  spelling.
- This change compiles against a harness that exports `shelfKey`, and it
  reads a graph of version 2 only.
