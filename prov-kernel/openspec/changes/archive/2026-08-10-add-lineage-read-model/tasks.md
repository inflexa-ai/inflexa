## 1. The read module

- [x] 1.1 Add `src/lineage.ts`: the node/edge types, the attribute readers,
  and `deriveLineageModel` — parse, unify under `PROV_UNIFY_OPTIONS`, derive
  typed nodes, derive the seven edge kinds in the PROV assertion orientation
  with deterministic ids, synthesize undeclared endpoints, skip unknown
  statement kinds, inherit a command's run/step from its informing step.
- [x] 1.2 Add `computeLineage` with the CLI traversal semantics: generation
  and usage only, forward/backward, the file-hop depth bound (`2n` from a
  file root, `2n - 1` from an activity root), minimum distance over all roots.
- [x] 1.3 Add `findFileEntity`: the `(path, hash)` file-entity lookup, typed
  on the existing `ProvFileKey`.
- [x] 1.4 Export the functions and the model types from `src/index.ts`.

## 2. Tests

- [x] 2.1 Golden-fixture derivation: node and edge structure, the
  deterministic dialect edge ids, the value-derived fallback ids, the
  synthesized endpoints, the edge-kind census, determinism, and the
  `prov_corrupt` err channel.
- [x] 2.2 Traversal tests ported from the CLI semantics: the backward chain,
  the step-grain leaf, the cross-run prior read, the self-read cycle, the
  forward walk, the depth bounds for file and activity roots, the multi-root
  minimum-distance bound.
- [x] 2.3 Tolerance tests ported from Lumen: the anonymous and the identified
  invalidation, synthesized endpoint nodes, a skipped statement kind outside
  the seven.
- [x] 2.4 `findFileEntity` hit and miss.
- [x] 2.5 The golden fixture stays byte-identical — the read module touches no
  write-path code.

## 3. Documents and version

- [x] 3.1 Update `README.md`, `CLAUDE.md`, the barrel doc comment, and the
  smoke script's export list.
- [x] 3.2 Bump `package.json` to 0.4.0 (shared with the rename change).
- [x] 3.3 `bun install --frozen-lockfile`, `bun run typecheck`,
  `bun run lint`, `bun test`, `bun run build && bun run smoke`,
  `openspec validate --all --strict`.
- [x] 3.4 `bun run format:file` on every touched file under `src/`.
