## Why

`inflexa prov lineage` (issue #66, PR #72) hand-rolls a traversal layer —
index, ref resolution, bounded cycle-safe walk, flat JSON projection — that
`@inflexa-ai/tsprov` 0.5.1 now owns natively under its `/graph` subpath
(issue #74). The library was extended precisely so this generic graph work
would live at its source; keeping a 502-line app-side copy means two
implementations of the same contract drifting apart. Adopting the library
shrinks `lineage.ts` to what is genuinely inflexa's — the attribute
vocabulary, step-grain labeling, the tree renderer, and CLI plumbing — and
un-descopes `--format dot`, which was dropped only because it implied
dependency-shaped work that the library's flat projection now makes a
~30-line pure formatter.

## What Changes

- Bump `@inflexa-ai/tsprov` from 0.4.0 to 0.5.1 (GitHub registry; verified
  published).
- Rewrite `cli/src/modules/prov/lineage.ts` internals onto
  `@inflexa-ai/tsprov/graph`:
  - `buildLineageIndex` → `provToGraph(doc, PROV_UNIFY_OPTIONS)` (the
    existing `unified()` call folds into it).
  - `resolveFileRef` → `resolve`/`resolveUnique` with attribute selectors
    (`inflexa:path` equals, `inflexa:hash` equals, `inflexa:hash`
    startsWith); the ≥6-char prefix guard and path→hash→prefix precedence
    stay CLI-side.
  - `walkLineage` → `lineage(graph, roots, { direction, relations:
    [ProvGeneration, ProvUsage], depth })` — explicit relation list (never
    the default `"dataflow"` profile), CLI `--depth` doubled to edge hops.
  - `formatJson`'s graph core → `toFlatGraph(result)`, with node keys
    translated back to prefixed QNames at the formatting boundary so the
    JSON contract (`nodes` keyed by QName) is unchanged.
  - The local `MAX_WALK_DEPTH`/`normalizeAttrValue` duplicates are deleted
    in favor of the library's exports.
- Keep unchanged: the tree renderer, step-grain labeling and scoped absence
  claims, terminal-input wording, run/step spine labels (now an adjacency
  read over `wasInformedBy` edges, not part of the walk), and all CLI
  behavior contracted by the existing specs.
- Add `--format dot`: a pure formatter over the flat graph emitting Graphviz
  `digraph` text (`| dot -Tsvg` works), reversing the deliberate descope now
  that it costs no dependency.
- Extend the reference grammar with substring search: a ref the exact
  path/hash/prefix probes miss is searched across recorded file paths,
  command lines, and tool names (the library's `includes` selectors, shipped
  in 0.5.1). A unique match walks — including rooting the walk at a COMMAND
  activity, not just a file; several distinct matches fail with a
  kind-tagged candidate listing; directory-style refs get no special
  semantics (they fail through the same candidate/not-found messages).
- The existing 17 lineage tests are the oracle: they SHALL pass against the
  rewritten internals; only tests pinning deleted internal function names
  may be rehomed onto the surviving public surface.

## Capabilities

### New Capabilities

None — this change rewrites the implementation of an existing capability and
extends its rendering surface.

### Modified Capabilities

- `prov-lineage`: a new requirement adds the `dot` rendering (reversing the
  explicit "no dot SHALL be emitted" descope, which is dropped from the
  tree/JSON requirement); the cycle/depth requirement restates the safety
  ceiling as the graph engine's (1000 edge traversals ≈ 500 file-level
  hops) and pins that CLI `--depth` units are file-level hops. Two further
  new requirements add the substring-search fallthrough and activity-rooted
  walks. The exact-reference resolution and file-rooted walk requirements
  are untouched — the engine swap is implementation, recorded in the
  design, not a behavior change.
- `cli-core`: the `inflexa prov lineage` registration requirement gains
  `--format tree|json|dot` and broadens the `<file>` argument to a record
  reference (path, hash, hash prefix, or search string).

## Impact

- **Code**: `cli/src/modules/prov/lineage.ts` (roughly its first half —
  index, resolution, walk, JSON graph core — deleted in favor of library
  calls); `cli/src/modules/prov/lineage.test.ts` (oracle; minimal rehoming
  of tests that named deleted internals); `cli/package.json` + `bun.lock`
  (tsprov 0.5.1).
- **Dependencies**: `@inflexa-ai/tsprov` 0.4.0 → 0.5.1. No new packages —
  the graph engine ships inside the existing dependency.
- **Behavior**: CLI output is byte-identical for `tree` and `json` on
  exact references (QName-keyed nodes preserved via boundary translation);
  `dot` and the substring-search fallthrough are additive — every reference
  that resolves today resolves identically.
- **Supersedes**: the app-side traversal introduced by PR #72 (archived
  change `add-prov-lineage`); issues #66/#74 are the motivating record.
