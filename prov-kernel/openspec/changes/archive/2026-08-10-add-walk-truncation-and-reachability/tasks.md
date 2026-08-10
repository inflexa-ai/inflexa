## 1. The walk core

- [x] 1.1 Extract the shared traversal core from `computeLineage`: directed
  adjacency over a selected edge-kind set, budget-keyed breadth-first
  expansion, and the in-walk truncation collection (final budget 0 with a
  nonempty qualifying adjacency).
- [x] 1.2 `computeLineage` returns `LineageWalk` — the reached sub-model plus
  `truncated` — with unchanged depth semantics and the unchanged
  generation/usage edge set.
- [x] 1.3 Add `computeReachable` over the same core: unbounded budgets, every
  edge kind by default, `edgeKinds` narrowing, and `"both"` as the union of
  the backward and forward closures.
- [x] 1.4 Export `computeReachable` and `LineageWalk` from `src/index.ts`.

## 2. Tests

- [x] 2.1 Truncation: the cut file is truncated, the unbounded walk reports
  none, a bound node with nothing beyond it stays unmarked, the activity-root
  and forward variants, and a second root un-truncating what it re-expands.
- [x] 2.2 Equivalence: the in-walk `truncated` matches the depth+1 diff
  derivation over four fixture models, every single-node root, multi-root and
  mixed-kind root sets, both directions, depths 0–4.
- [x] 2.3 Reachability: the full dataflow cone from a consumed input, agents
  reached via association/attribution and the analysis via derivation from a
  produced file, a sibling's exclusive output excluded, `edgeKinds`
  narrowing, an absent root, directional closures, and the
  generation/usage-restricted closure equal to the unbounded lineage scope.
- [x] 2.4 The golden fixture stays byte-identical — the change is read-side
  only.

## 3. Documents and version

- [x] 3.1 Update `README.md`, `CLAUDE.md`, the module doc comment, and the
  smoke script's export list.
- [x] 3.2 Bump `package.json` to 0.5.0.
- [x] 3.3 `bun run typecheck`, `bun run lint`, `bun test`,
  `bun run build && bun run smoke`, `openspec validate --all --strict`.
- [x] 3.4 `bun run format:file` on every touched file under `src/`.
