## 1. Dependency bump

- [x] 1.1 Bump `@inflexa-ai/tsprov` to `0.5.1` in `cli/package.json` and run `bun install` (GitHub registry; fails fast on missing credentials)
- [x] 1.2 Smoke-check the subpath import compiles: `import { provToGraph } from "@inflexa-ai/tsprov/graph"` typechecks from `src/modules/prov/`

## 2. Graph adapter — build, resolve, walk (design D1–D3, D5–D7, D9)

- [x] 2.1 Add `lineageGraph(doc): ProvGraph` wrapping `provToGraph(doc, PROV_UNIFY_OPTIONS)`; delete `buildLineageIndex`, the `LineageIndex` type, and the local `normalizeAttrValue`/`attrString`/`attrStrings`/`push` helpers (attribute reads move to the library's `normalizeAttrValue`, first-form `[0]` per D7)
- [x] 2.2 Rewrite `resolveFileRef(graph, ref)` on `resolve`/`resolveUnique` selectors: exact `inflexa:path` → exact `inflexa:hash` → `startsWith` hash prefix with the ≥6-char guard CLI-side; map `ambiguous` → `err ambiguous_hash`; not-found sample from the one-time `file-*` entity sweep via the injectable matcher (never tsprov's mixed-kind orientation sample); keep the `Result<LineageFileInfo[], LineageRefError>` contract
- [x] 2.3 Add `computeLineage(graph, infos, { forward, depth })`: ONE multi-root `lineage()` call with explicit `relations: [ProvGeneration, ProvUsage]` and `depth: 2 * n` (unset stays unset); delete `walkLineage` and the local `MAX_WALK_DEPTH`
- [x] 2.4 Rebuild the activity labeler on graph adjacency: kind from `prov:type`, run/step spine for commands via the `ProvCommunication` out-edge lookup (never walked), facts off `node.element` attributes

## 3. Renderers over the library result (design D4–D5, D8)

- [x] 3.1 Rebuild the `LineageFile`/`LineageActivity` tree intermediate from `result.edges` (one `from → edges` index): per-root render-time visited set (revisit checked before depth), per-root file-hop `--depth` enforcement, `[depth limit]` iff onward edges exist in the result or a `frontier` entry covers the node; `formatTree` itself unchanged
- [x] 3.2 Rebuild `formatJson` on `toFlatGraph(result)`: translate node keys URI → prefixed QName at the boundary; keep the `{ roots, nodes, edges }` shape, kind-specific fields, PROV-orientation edges, and merged-graph `truncated` semantics
- [x] 3.3 Rehome `lineage.test.ts` onto the D9 seam (`lineageGraph`/`resolveFileRef`/`computeLineage`/`formatTree`/`formatJson`): scenarios and assertions preserved; all 17 pass with `tree`/`json` output byte-identical; assertions on the deleted walk-output shape re-target the rendered output

## 4. dot format (design D10)

- [x] 4.1 Add `formatDot(graph, result)`: pure `digraph` formatter over the flat graph — QName node ids, tree-fact labels with `"`/`\` escaping, files vs activities visually distinct, truncated nodes marked, PROV-orientation edges
- [x] 4.2 Wire `--format dot` through `parseOptions` and the command registration (`src/cli/index.ts` help text `tree|json|dot`); unknown format error lists all three
- [x] 4.3 Tests: dot output is a syntactically valid digraph whose edge set matches the JSON edges on the canonical chain; a depth-truncated node is visibly marked

## 5. Verification

- [x] 5.1 `bun run typecheck`, `bun run lint`, `bun test` all green from `cli/`
- [x] 5.2 `bun run format:file` on every touched file under `src/`
- [x] 5.3 Manual smoke on a real analysis: `inflexa prov lineage <analysis> <file>` (tree), `--format json`, `--format dot | dot -Tsvg` if graphviz is present, `--forward`, `--depth 1`

## 6. Substring-search resolution (design D11–D12)

- [x] 6.1 Rename `resolveFileRef` → `resolveLineageRef` returning `Result<LineageRoots, LineageRefError>` with `LineageRoots = { kind: "files"; infos } | { kind: "activity"; qn }`; exact path/hash/prefix tiers unchanged
- [x] 6.2 Add the search tier: `includes` selectors over `inflexa:path` (entities), `inflexa:command`/`inflexa:tool` (activities); same-path entity matches collapse to the exact-path multiplicity; single record resolves; hashes never substring-searched
- [x] 6.3 Add `ambiguous_search` to `LineageRefError` (kind-tagged candidates, capped at 10 with a "+ n more" tail) and its CLI failure message; zero matches keeps the known-paths failure; directory-style refs get no special handling

## 7. Activity-rooted walks (design D13)

- [x] 7.1 `computeLineage` accepts the activity root: depth factor `2n - 1` for an activity root (`2n` for file roots), same explicit relations
- [x] 7.2 Tree: an activity root renders its own `activityFacts` line (no verb) with used (backward) / generated (forward) files beneath, expanding as normal file nodes; scoped-absence wording unchanged
- [x] 7.3 Verify JSON and dot carry the activity QName in `roots` unchanged in shape (kind-agnostic already — pin with tests, code changes only if a gap appears)

## 8. Search tests + verification

- [x] 8.1 Tests: unique filename fragment ≡ full path; command fragment roots at the activity (backward AND forward trees + json roots); same-path two-hash fragment walks both; cross-kind ambiguity fails kind-tagged and capped; zero-match keeps known-paths; exact refs never reach the search tier
- [x] 8.2 `bun run typecheck`, `bun run lint`, `bun test` green from `cli/`; `bun run format:file` on touched files
- [x] 8.3 Real-analysis smoke: a filename fragment, a command fragment (e.g. `python`, expecting ambiguity), a unique script name, and the user's original folder-style ref failing nicely
