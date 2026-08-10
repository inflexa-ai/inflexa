# Add the lineage read model

## Why

The dialect had one write-side interpretation (the event switch) but no
read-side one. Each consumer interpreted the stored bytes itself: the CLI's
lineage command classified nodes and walked the graph in its own module, and
Lumen's provenance view derived its own node/edge model with its own attribute
readers. Two readers of one signed document can drift, and drifted readers show
two different lineages for the same bytes. The interpretation of the dialect is
format semantics, thus it belongs in the kernel, one time.

## What Changes

- Add `src/lineage.ts`: the lineage read model.
  - `deriveLineageModel(provJson)` parses the exact stored PROV-JSON bytes
    through tsprov, unifies under `PROV_UNIFY_OPTIONS`, and returns
    `{ nodes, edges }` — typed, presentation-free nodes (analysis, input, file,
    activity, agent) and edges for the seven relation kinds with deterministic
    ids. Bytes that do not parse return `err({ type: "prov_corrupt" })`.
  - `computeLineage(model, roots, { direction, depth? })` walks the
    generation/usage edges with the traversal semantics of the CLI's lineage
    command.
  - `findFileEntity(model, { path, hash })` is the identity lookup that
    cross-links an external artifact record to its entity.
- Port, do not invent: the CLI module is canonical for the traversal semantics
  and the attribute readers; the Lumen derivation is canonical for tolerance
  (synthesized nodes for undeclared endpoints, fallback ids for anonymous
  relations, skipped unknown statement kinds).
- Export the module from the barrel. tsprov stays the only import surface (an
  existing peer).
- Bump the package version from 0.3.0 to 0.4.0 (shared with the
  rename-sidecar-attestation change).

## Capabilities

### Modified Capabilities

- `prov-kernel`: the kernel gains the read-side requirement — one lineage
  interpretation of a stored document, owned next to the write-side mapping.

## Impact

- `src/lineage.ts` (new), `src/lineage.test.ts` (new), `src/index.ts`,
  `README.md`, `CLAUDE.md`, `scripts/smoke.mjs`, `package.json`.
- No write-path change: the golden fixture bytes are untouched.
- Consumers adopt the module in their own changes: the CLI keeps its
  presentation (tree/JSON/dot/mermaid rendering, ref search), Lumen keeps its
  React Flow layout and filters.
