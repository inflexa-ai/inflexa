## Context

`cli/src/modules/prov/lineage.ts` (502 lines, PR #72 / archived change
`add-prov-lineage`) hand-rolls a graph layer over the stored PROV document:
`buildLineageIndex` (adjacency maps + attribute normalization),
`resolveFileRef` (git-style path/hash/prefix resolution), `walkLineage`
(bounded cycle-safe recursive walk), and `formatJson`'s graph core (dedup +
truncation marking). `@inflexa-ai/tsprov` 0.5.1 ships all four as a
general-purpose engine under the `/graph` subpath (issue #74):
`provToGraph`/`ProvGraph`, `resolve`/`resolveUnique`, `lineage` (multi-root
directional BFS with explicit `frontier` truncation), and
`toFlatGraph`/`toProvDocument`/`lineagePaths` views. tsprov is our own
library; generic graph work belongs at its source, not copied per embedder.

The API surface was verified against the tsprov repo (0.5.1, published on
the GitHub registry): all named exports exist; one deviation from the
issue's sketch is that `normalizeAttrValue` returns `readonly string[]`
(every matchable form — a QName yields both URI and `prefix:localpart`),
not a single string.

The 17 tests in `lineage.test.ts` build documents with the REAL builders
and currently import the four internals directly — they are the behavioral
oracle and must survive on the rewritten module's public seam.

## Goals / Non-Goals

**Goals:**

- Delete the app-side traversal engine; keep only what is genuinely
  inflexa's: the `inflexa:*` attribute vocabulary, step-grain labeling and
  scoped absence claims, the tree renderer, and CLI plumbing.
- Byte-identical `tree` and `json` output on the oracle scenarios.
- Add `--format dot` as a pure formatter over the library's flat projection.
- Extend the reference grammar with a substring-search fallthrough over
  file paths, command lines, and tool names — including walks rooted at a
  command activity — on the library's `includes` selectors (already in
  0.5.1; no library change needed).
- Preserve the neverthrow contract: resolution failures stay the
  `LineageRefError` discriminated union on the `Result` error channel.

**Non-Goals:**

- The harness-side recording gaps from #66 (`read_file` invisible to
  lineage, `recordFileToolWrite` uncalled, per-input `wasDerivedFrom`).
- `--paths-to <ref>` (`lineagePaths`), `direction: "both"`, and PROV-native
  export of a lineage slice (`toProvDocument` → `--format provn|prov-json`)
  — unlocked by this adoption, deliberately not taken here.
- Directory/folder semantics for references (user-rejected: a folder is
  not a provenance identity; such refs fail through the normal candidate
  and not-found messages), and edge-rooted walks (no CLI grammar names an
  edge; the library already supports them when one does).
- Any TUI entry for lineage.
- Changes to what the recorder writes (schema, storage, signing).

## Decisions

### D1 — Boundary: the library owns the graph, the CLI owns the vocabulary

`provToGraph(doc, PROV_UNIFY_OPTIONS)` replaces `unified()` +
`buildLineageIndex` (the unify options forward through, so the existing
`doc.unified(PROV_UNIFY_OPTIONS)` call folds into the one constructor).
Everything downstream reads the `ProvGraph` adjacency
(`outEdges`/`inEdges`) and each `GraphNode.element`'s attributes. The
`inflexa:path`/`hash`/`source`/`command`/`exitCode`/`tool`/`runId`/`stepId`
vocabulary, the `kind` classification from `prov:type`, and all rendering
stay CLI-side — they are product semantics, not graph mechanics.
*Alternative rejected:* keeping the local index for "independence" — tsprov
is our repo; limitations get fixed at source, not worked around per
embedder.

### D2 — The walk traverses exactly `[ProvGeneration, ProvUsage]`

`lineage()` is called with the explicit relation-class list, never the
default `"dataflow"` profile. The default also traverses `ProvDerivation`
and `ProvCommunication`: our document carries the deliberately-coarse
`wasDerivedFrom(file, analysis)` edge (which the walk must ignore — it
exists for generic PROV consumers), and traversing `wasInformedBy` would
attach every command's step-grain context to its lineage. `wasInformedBy`
remains a LABEL lookup, not a walk edge: the run/step spine for a command
node is an adjacency read —
`graph.outEdges(activityUri).find((e) => e.relation instanceof ProvCommunication)?.to`
— then attributes off that node. `provToGraph` indexes ALL relations, so
communication edges are present for the lookup even though the walk never
follows them.

### D3 — Depth: CLI units are file hops; the library counts edge hops

One CLI `--depth` unit (file → activity → file) is two PROV edges, so the
adapter passes `depth: 2 * n`; frontier entries then land on file entities,
matching the PR's markers. `--depth` unset stays unset: the library's
`MAX_WALK_DEPTH` ceiling (1000 edge hops ≈ 500 file-level hops) backs
"unbounded", truncating visibly with `reason: "ceiling"` instead of
overflowing a stack (both the walk and the path enumerator are iterative).
The ceiling renders the SAME truncation marker as a user depth bound —
`reason` distinguishes them internally, but for the reader both mean "the
walk stopped here, the branch is incomplete". Note the effective ceiling
halves versus the PR's 1000 file-hop recursion cap; anything past 500
file-generations deep is pathological either way, and the spec delta
restates the ceiling honestly.

### D4 — JSON keeps prefixed-QName node keys, translated at the boundary

`GraphNode.uri`/`LineageFlatNode.uri` are full URIs; the documented JSON
contract (and the oracle) key `nodes` by prefixed QName
(`inflexa:file-…`). The formatter translates once at the boundary via
`node.element.identifier?.toString()`. *Alternative rejected:* adopting URI
keys — it breaks the published `--format json` contract and every JSON
oracle assertion for zero user value; #74 explicitly leaves the translation
as the sanctioned option.

### D5 — One multi-root walk; the tree renderer enforces per-root depth

The command makes ONE `lineage(graph, roots, …)` call with every resolved
entity as a root (the multiplicity case: same path, several hashes).
`toFlatGraph` of that single result IS the JSON graph core — the PR's
merged `{roots, nodes, edges}` with "truncated only if no expansion
recorded it" semantics falls out of BFS min-distance by construction.

The tree, which renders one lineage PER root with the PR's per-root depth
semantics, is re-derived from `result.edges` (a `from → edges` index built
once): the renderer recurses per root with its own render-time visited set
(`[already shown above]` on re-encounter — revisit checked before depth,
as today) and enforces the file-hop `--depth` bound itself, emitting
`[depth limit]` where it cuts. This is exact, not approximate: BFS reaches
every node at its minimum distance over all roots, which is ≤ its distance
from any single root, so the merged bounded result contains every edge any
per-root render up to the same bound can need. A node the renderer does
not cut is `[depth limit]` iff it has onward edges in the result or a
`frontier` entry (the ceiling case); otherwise its emptiness is genuine
and renders the existing terminal/absence wording. *Alternative rejected:*
one `lineage()` call per root for the tree — extra walks to reproduce
what the equivalence argument gives for free.

### D6 — Resolution: library selectors, CLI-side precedence and sample

`resolveFileRef`'s contract is unchanged; its body becomes three selector
probes in today's precedence: exact path
(`resolve` on `{ name: "inflexa:path", equals: ref }` — `matched` carries
ALL entities for the path, multiplicity surfaced), then exact hash
(`resolve` on `inflexa:hash` equals), then hash prefix
(`resolveUnique` on `inflexa:hash` startsWith), with the ≥6-char guard
staying CLI-side. tsprov's `ambiguous` outcome maps to
`err({ type: "ambiguous_hash", candidates })`. The not-found path does NOT
use tsprov's orientation `sample` (it mixes all record kinds; the spec
promises file PATHS): the module collects the file-entity candidate set
once with the injectable matcher —
`resolve(graph, { type: ProvEntity, where: (r) => r.identifier?.localpart.startsWith("file-") ?? false })`
— which also supplies the walk-independent facts the old `index.files`
carried. All probes are typed selectors on ProvEntity, so a same-valued
attribute on an activity can never shadow a file.

### D7 — Attribute reads take the lexical form

The library's `normalizeAttrValue` replaces the local helper, but it
returns EVERY matchable string form (`readonly string[]`). The adapter's
first-value read (`attrString` equivalent) takes element `[0]` — the
lexical/primary form — for display facts. This is the one place the
issue's sketch and the shipped API differ; pinning it here prevents a
silent "renders the URI form" regression, and the oracle's label
assertions catch it.

### D8 — The tree intermediate survives; the renderer does not change

`LineageFile`/`LineageActivity` stay as the rendering intermediate, now
built from `result.edges` + node elements instead of by the walk itself.
`formatTree` is untouched — step-grain labeling, scoped absence wording
("no step-grain outputs", "no recorded generation — terminal input"), and
marker text are the product surface the oracle pins.

### D9 — The module's public seam (what the oracle rehomes onto)

The deleted internals are replaced by a seam with the same headless,
pure-over-a-document property the tests rely on:

- `lineageGraph(doc): ProvGraph` — `provToGraph` + `PROV_UNIFY_OPTIONS`.
- `resolveFileRef(graph, ref): Result<LineageFileInfo[], LineageRefError>`
  — same name, same contract, graph-typed first parameter.
- `computeLineage(graph, infos, { forward, depth }): LineageResult` — the
  single multi-root library call (D5), depth doubling (D3) inside.
- `formatTree(graph, result, opts): string`,
  `formatJson(graph, result): LineageJson`,
  `formatDot(graph, result): string`.

Test rehoming is mechanical: scenarios and assertions stay; construction
swaps `buildLineageIndex`/`walkLineage` for
`lineageGraph`/`computeLineage`. Tests asserting on the deleted
`LineageFile.marker` walk-output shape re-target the rendered output the
markers exist for.

### D10 — dot is a pure formatter over the flat graph

`formatDot` emits a Graphviz `digraph` from the same flat projection JSON
uses: node ids are the prefixed QNames (D4), labels carry the tree's facts
(path + 12-char short hash for files; command + exit code, tool, or
step-grain marking for activities), files and activities visually distinct
(shape), truncated nodes visibly marked, edges in asserted PROV semantics
(`wasGeneratedBy` entity→activity, `used` activity→entity) exactly like
JSON — direction-independence is part of the format's contract. Labels are
quoted with `"` and `\` escaped. No layout hints, no colors, no new
dependencies — `| dot -Tsvg` is the consumer.

### D11 — Substring search is the last resolution tier, over three targets

When the exact-path, exact-hash, and hash-prefix probes all miss, the ref
is searched as a substring via the library's `includes` attribute predicate
(shipped in 0.5.1 — verified in the published dist) over exactly three
targets: `inflexa:path` on entities, `inflexa:command` and `inflexa:tool`
on activities. Content hashes are deliberately NOT substring-searched —
hash addressing stays exact-or-prefix (git-style); a substring hit inside
a digest is noise, never intent. Matching is case-sensitive (paths and
command lines are case-sensitive artifacts). Run/step identifiers need no
target of their own: recorded paths embed them, so "step-4" finds its
files through the path target.

Outcome policy: a single matched record resolves and walks. Matches that
are all file entities carrying the SAME path collapse to that path's
entity set and walk like today's exact-path multiplicity (same logical
file, several hashes — consistency with the exact tier). Anything else —
several distinct paths, several activities, or a mix — fails with a
kind-tagged candidate listing (files as `path (hash …)`, activities as
their command/tool line with step and run), capped at 10 with a
"+ n more" tail, so the user re-asks with a copyable exact ref. Zero
matches falls through to today's known-paths sample. Directory-style refs
get NO special semantics (user decision): a trailing-slash ref simply
lands in the candidate or not-found failure like any other string.
*Alternative rejected:* walking every distinct match — a vague ref
exploding into a forest is surprise, not help.

### D12 — Resolution returns a kind-discriminated root set

`resolveFileRef` becomes `resolveLineageRef(graph, ref)` returning
`Result<LineageRoots, LineageRefError>` where `LineageRoots` is
`{ kind: "files"; infos: LineageFileInfo[] } | { kind: "activity"; qn: string }`
— the walk can now root at a command activity, so the resolver's output
must say which shape it found. `LineageRefError` gains an
`ambiguous_search` variant carrying the kind-tagged candidates (the
existing `ambiguous_hash` stays as-is). The seam otherwise keeps D9's
shape; `computeLineage` takes the root QNames regardless of kind.

### D13 — Activity-rooted walks: depth mapping and root rendering

An activity root's first traversed edge is activity→file (one edge), so
one CLI file-hop unit beneath an activity root is `2n - 1` engine edge
hops (a file root stays `2n`). Root sets are homogeneous by construction
(a search resolves to files OR one activity), so `computeLineage` picks
the factor per root kind. The tree renders an activity root as the
activity's own fact line (the shared `activityFacts` — command + exit
code, step, run; no "generated by:"/"used by:" verb, since the root is
not reached VIA an edge), with its used files (backward) or generated
files (forward) beneath, each expanding as a normal file node. The
existing scoped-absence wordings apply beneath it unchanged. JSON and dot
need no shape change: both are already kind-agnostic and simply carry the
activity QName in `roots`. Edge-rooted walks (the library supports them —
an edge root seeds both endpoints) are deliberately NOT exposed in this
change: no CLI grammar names an edge yet; noted as future work.

## Risks / Trade-offs

- [Registry availability] `bun install` of 0.5.1 needs GitHub-registry auth
  (`@inflexa-ai:registry=https://npm.pkg.github.com`) → verified 0.5.1 is
  published; install failure is an environment credential issue, surfaced
  immediately by task 1.
- [`unified()` throws on conflicting formal times — known tsprov
  limitation] `provToGraph` forwards to `unified()` → no NEW exposure: the
  current code already unifies with the same options on the same stored
  bytes; any document that would throw already throws today.
- [Depth-doubling off-by-one] a wrong factor or fencepost shifts every
  `--depth` cutoff → the oracle's depth-cutoff scenario pins the boundary;
  frontier entries landing on activity nodes (odd effective depth) would
  make the mislabeling visible in review.
- [Attribute form regression] `normalizeAttrValue`'s array return (D7)
  misread as a scalar would render URI forms in labels → oracle label
  assertions cover command/path/hash rendering.
- [Ceiling halved] 1000 edge hops ≈ 500 file hops versus the PR's 1000
  file hops → accepted: both are far past any real pipeline; the spec delta
  states the new bound and the marker behavior is unchanged.
- [Behavioral drift hiding in the rewrite] the walk/format core changes
  wholesale → the 17 oracle tests run against real-builder documents
  round-tripped like the stored column; `tree`/`json` must be
  byte-identical, and any assertion edit beyond the D9 rehoming is a review
  flag, not a fixture update.

## Migration Plan

Single PR on this branch, replacing PR #72's approach (that PR's spec+code
are already on `main`; this change amends in place):

1. Bump `@inflexa-ai/tsprov` to 0.5.1, `bun install`.
2. Rewrite `lineage.ts` internals per D1–D10; delete `buildLineageIndex`,
   `resolveFileRef`'s scan body, `walkLineage`, `formatJson`'s graph core,
   local `MAX_WALK_DEPTH` and `normalizeAttrValue`.
3. Rehome the oracle tests onto the D9 seam; run them; `tree`/`json` output
   byte-identical.
4. Add `formatDot` + `--format dot` plumbing + its tests.
5. Extend resolution with the search tier and activity roots per D11–D13;
   rehome the resolver's callers/tests onto `resolveLineageRef`.
6. `bun run typecheck && bun run lint && bun test`, then
   `bun run format:file` on touched `src/` files.

Rollback: revert the branch commits — no schema, storage, or recorded-data
migration is involved (read-side only).

## Open Questions

None — the JSON key-shape question #74 left open is decided by D4 (keep
QNames), and the ceiling-halving is accepted by D3.
