## Context

`inflexa prov lineage` resolves a reference through four tiers today (exact
path → exact hash → hash prefix → substring over path/command/tool) and
renders `tree`/`json`/`dot`. Four gaps, each verified against real
documents:

- A ref equal to a record's QName identifier (`input-7ai1j57nqx1l`, or its
  prefixed `inflexa:input-…`) resolves to nothing — we search attributes,
  never identifiers. Yet that is the exact token the exported PROV JSON uses
  (`prov:usedEntity`).
- The not-found hint (`src/modules/prov/lineage.ts:141`) sweeps only
  `file-*` localparts; a profile-only document's sole pathed entity is
  `inflexa:input-…`, so the hint comes back empty.
- `findAnalysisForProv` (`src/modules/prov/document.ts:581-583`) returns
  `rows[0]` of a newest-first list, so `prov lineage a1` silently picks the
  newest of several same-named analyses.
- The `tree` repeats a shared intermediate as `[already shown above]`; the
  real DAG (one node, several edges) is only visible in `json`/`dot`.

tsprov 0.5.1's graph layer already has the pieces for the first: `resolve`
accepts an `id` selector (a URI or `prefix:localpart`, resolved against the
document's namespaces the same way `getRecord` does) and a `where` matcher
over `identifier.localpart`; `lineage()` accepts a `ProvRecord`,
`QualifiedName`, or `prefix:localpart` string as a root. Verified in the
installed `dist/graph/resolve.d.ts` and `roots.ts`.

## Goals / Non-Goals

**Goals:**

- Resolve a reference by the record's own identifier (prefixed QName or
  bare localpart), for entities and activities.
- Make the not-found hint list every pathed entity, not just `file-*`.
- Make prov-command analysis resolution fail on an ambiguous name/slug,
  listing candidates, instead of silently taking the newest.
- Add `--format mermaid` emitting Mermaid `flowchart` source, no new
  dependency, `tree` still default.

**Non-Goals:**

- Bundling a Mermaid renderer (`beautiful-mermaid`/`elkjs`, ~11 MB) — the
  CLI emits source, the user renders. Explicitly rejected on footprint.
- Interactive disambiguation of an ambiguous analysis name (no TTY
  assumption in a headless-first prov command — fail with candidates).
- Substring search over identifiers (the identifier tier is exact prefixed
  QName or exact localpart; a fuzzy identifier match would collide with the
  existing path/command/tool substring tier and muddy precedence).
- Any change to what the recorder writes.

## Decisions

### D1 — Identifier tier sits after substring, exact-match only

The resolution order becomes: exact path → exact hash → hash prefix →
substring (path/command/tool) → **identifier**. Identifier resolution is
EXACT, two accepted forms: the full prefixed QName (`inflexa:input-…`) and
the bare localpart (`input-…`). It runs via the tsprov `id` selector
(prefixed form) and a `where: (r) => r.identifier?.localpart === ref`
matcher (bare form), over both entities and activities. A single match
resolves — an entity match yields `kind: "files"` with that one info; an
activity match yields `kind: "activity"`. Placing it LAST keeps every
reference that resolves today resolving identically (a path that happens to
equal some localpart is vanishingly unlikely, and the path tier wins
anyway). *Alternative rejected:* placing it before substring — a QName
localpart contains hyphenated tokens (`input-7ai…`) that could shadow a
substring intent; last-place avoids the precedence question entirely.

### D2 — The identifier tier reuses the resolved-root union

`resolveLineageRef` already returns `Result<LineageRoots, LineageRefError>`
with `LineageRoots = { kind: "files"; infos } | { kind: "activity"; qn }`.
The identifier tier produces exactly those shapes, so `computeLineage` and
both renderers need no change — an `input-…` entity walks as a file root, an
activity identifier walks as an activity root (the activity-root machinery
from the prior change already handles the tree/json/dot for it). No new
outcome variant is needed on success; a lone identifier match is
unambiguous by construction (identifiers are unique).

### D3 — The not-found sample sweeps every pathed entity

`fileEntities` (`lineage.ts:110`, the source of both the not-found sample
and — today — nothing else) changes its matcher from
`localpart.startsWith("file-")` to "carries an `inflexa:path` attribute".
That is the honest predicate for "a file the document knows about,"
independent of the QName minting scheme, and it matches what the substring
tier already resolves against. The sample stays capped at
`NOT_FOUND_SAMPLE` and deduped by path. *Alternative rejected:* union of
`file-` and `input-` prefixes — brittle against any future entity kind that
carries a path; the attribute predicate is the invariant.

### D4 — Analysis-name ambiguity fails with candidates, in the resolver's shape

`findAnalysisForProv` becomes ambiguity-aware. `findAnalysesByRef` already
returns ALL candidates ordered `(id = ref) DESC, created_at DESC`. The new
contract:
- an exact-id match (first row has `id === ref`) → that one analysis,
  unambiguous;
- exactly one row → that analysis;
- several rows, none by id → an ambiguity error carrying each candidate's
  id, name, and creation time.

Rather than widen `findAnalysisForProv`'s `Result<Analysis | null, DbError>`
across every prov caller, the ambiguity is surfaced at the prov-command
boundary: a small resolver returns
`Result<Analysis, { type: "not_found" } | { type: "ambiguous"; candidates }>`
and each prov action (`lineage`/`export`/`verify`/`verify-file`) renders the
ambiguity via `fail()`. This mirrors how the CLI already resolves id-or-name
elsewhere (`matchAnalysis` reshaping the candidate set) and keeps the DbError
channel clean. The `verify-file` action takes a path, not an analysis ref, so
it is unaffected — the resolver change touches the analysis-ref actions only.
*Alternative rejected:* an interactive picker — prov commands are
headless-first; a scripted invocation must fail deterministically, not block
on a prompt.

The resolver and its boundary wrapper live in `prov.ts`, the module's core —
NOT in `document.ts`, which is the tsprov-speaking layer (builders, QNames,
serialization) and must not grow CLI-boundary or db-resolution concerns.

Each candidate line carries the analysis's id, name, creation time, and the
anchor folder's last-known path — the disambiguating fact a user actually
recognizes (same-named analyses usually differ by WHERE they live).
`anchors.cached_path` is that "last known path" by construction (an absolute
hint, reconciled to the live location by id). The candidates come from ONE
query (a LEFT JOIN of analyses to anchors in `db/primary_query.ts`, per the
one-query house rule); a missing anchor row is a normal desync, so the path
is nullable and renders as a placeholder, never an error. The timestamp uses
`toLocaleString()` — the same formatting the analyses listing
(`analysis/ls.ts`) already shows the user — not raw ISO.

### D5 — `--format mermaid` is a pure source emitter over the flat graph

`formatMermaid(graph, result)` mirrors `formatDot`: build the same flat
graph (`formatJson`'s projection — Qname-keyed nodes, PROV-oriented deduped
edges), then emit Mermaid `flowchart LR` text. Node ids are sanitized QNames
(Mermaid ids may not contain `:`; map `inflexa:file-…` to a safe token,
keeping a stable one-to-one mapping like `dot`'s quoting does). Shapes
follow the PROV visual convention — entities as rounded `id([label])`,
activities as rectangles `id[label]`. Labels carry the tree's facts (path +
short hash for files; command + exit code, tool, or step-grain marking for
activities), with Mermaid-significant characters escaped (`"`, and the label
wrapped so `#`, `(`, `)` in a command line don't break parsing — use the
`id["..."]` quoted-label form and escape embedded quotes). Edges encode the
relation: `-->|wasGeneratedBy|` (solid) and `-.->|used|` (dotted), in
asserted PROV orientation regardless of walk direction — identical edge set
to `json`/`dot`. Direction `LR` reads as cause→effect and suits wide
terminals; the consumer's renderer ultimately lays it out.

### D6 — Escaping and id-safety are the mermaid formatter's only real risk

Mermaid's grammar is fussier than DOT's: node ids can't contain `:` or `-`
in some renderers, and labels break on unescaped quotes and some
punctuation. The formatter SHALL (a) map each QName to a grammar-safe id via
a deterministic transform (e.g. replace non-alphanumerics with `_`, keep a
`Map` so the same QName always yields the same id and collisions are
impossible because the source QNames are unique), and (b) wrap every label
in the quoted form `id["…"]` with embedded `"` escaped as `#quot;`
(Mermaid's HTML-entity escape). Tests assert a command label containing `"`,
`(`, and `#` round-trips into parseable source.

## Risks / Trade-offs

- [Identifier tier collides with a path/command that equals a localpart] →
  placed LAST, so any exact path/hash/prefix/substring match wins first;
  only a ref matching NOTHING else reaches it. Test pins that an exact path
  still resolves as a file, not via identifier.
- [Ambiguity change affects export/verify, not just lineage] → intended:
  the silent-newest bug is in the shared resolver, so all analysis-ref prov
  commands benefit. Each action's failure message is pinned; unambiguous
  refs are unchanged (tests assert a unique name and an exact id both still
  resolve to one analysis).
- [Mermaid source doesn't parse in some renderer] → the id-safety +
  quoted-label + entity-escape rules (D6) are covered by a test that the
  emitted source parses (the `beautiful-mermaid`/`@mermaid-js` parser is a
  dev-only check, NOT a runtime dependency — if adding it even as devDep is
  unwanted, the test asserts the structural invariants instead: every id
  alphanumeric/underscore, every label quoted, edge set equals the JSON edge
  set). Decide the dev-check at implementation time; the shipped code has no
  new dependency either way.
- [mermaid vs dot near-duplication] → accepted: both are ~30-line pure
  formatters over the shared flat graph; the shared projection keeps them
  honest, and each targets a different consumer ecosystem.

## Migration Plan

Single change on the current branch:

1. Add the identifier resolution tier (D1–D2) + tests.
2. Broaden the not-found sweep (D3) + test (a profile-only document now
   yields a non-empty hint).
3. Add the analysis-ambiguity resolver and wire the prov actions (D4) +
   tests.
4. Add `formatMermaid` + `--format mermaid` plumbing (D5–D6) + tests.
5. `bun run typecheck && bun run lint && bun test`, `bun run format:file`
   on touched `src/` files, real-analysis smoke (the `input-…` ref, a
   profile-only not-found hint, an ambiguous `a1`, `--format mermaid` piped
   to a renderer).

Rollback: revert the change commits — read-side only, no schema/storage
migration.

## Open Questions

None — the dependency question (source emitter, no bundled renderer) and
the disambiguation strategy (fail with candidates, not interactive) are
settled above.
