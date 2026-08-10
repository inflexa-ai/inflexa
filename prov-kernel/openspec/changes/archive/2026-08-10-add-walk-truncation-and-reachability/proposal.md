# Report walk truncation and add a reachability primitive

## Why

The lineage walk returned the reached sub-model with no frontier information,
and it traverses only the generation/usage edges. Both properties pushed walk
responsibilities onto consumers: a consumer that renders a bounded lineage had
to re-derive the truncation by running the walk a second time one file hop
wider and diffing the edge sets, and a consumer that highlights a node's full
cone (agents and lifecycle context included) had to keep a private
bidirectional traversal over the whole edge list. A re-derived truncation and
a private traversal are both read-side interpretation, and two consumers that
traverse the same signed document differently can drift — thus both belong in
the kernel, next to the walk they duplicate.

## What Changes

- `computeLineage` returns `LineageWalk = LineageModel & { truncated: string[] }`:
  the reached sub-model plus the QNames of the in-scope nodes whose qualifying
  edges the depth bound left unexpanded. Computed inside the single walk — no
  wider re-walk. A node at the bound with nothing beyond it is not truncated.
  Depth semantics (file hops, the `2n`/`2n - 1` edge budget) and the
  generation/usage edge set are unchanged.
- Add `computeReachable(model, roots, { direction, edgeKinds? })`: the
  unbounded reachability closure for subgraph and highlight consumers. Every
  edge kind traverses by default; `edgeKinds` narrows the set; `"both"` is the
  union of the backward and forward closures from the same roots — an
  upstream-plus-downstream cone, not undirected connectivity.
- The two functions share one traversal core; the additions are additive, so
  the version bumps 0.4.0 → 0.5.0.

## Capabilities

### Modified Capabilities

- `prov-kernel`: the lineage read model gains self-reported truncation on the
  bounded walk and the reachability closure over a chosen edge-kind set.

## Impact

- `src/lineage.ts`, `src/lineage.test.ts`, `src/index.ts`, `README.md`,
  `CLAUDE.md`, `scripts/smoke.mjs`, `package.json`.
- No write-path change: the golden fixture bytes are untouched.
