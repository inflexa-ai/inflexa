## Why

Four rough edges on `inflexa prov lineage`, all surfaced by real use: a
reference that is the document's own identifier (`input-…`) does not
resolve; the not-found hint goes empty exactly for the youngest documents;
an ambiguous analysis name resolves silently to the newest; and the tree,
while compact, hides the true DAG shape (a shared intermediate is repeated
as `[already shown above]` rather than drawn once with several edges). None
is a correctness bug — each turns honest data into a worse answer than the
document can give.

## What Changes

- **Resolve a reference by the record's own QName identifier.** A ref that
  misses the path/hash/prefix and substring tiers is matched against entity
  and activity identifiers — the exact prefixed form (`inflexa:input-…`) or
  the bare localpart (`input-…`) — using the tsprov graph's identifier
  selectors, and `lineage()` accepts the resolved record as a root. This is
  the token a user copies straight out of the exported PROV JSON
  (`prov:usedEntity: "inflexa:input-7ai1j57nqx1l"`), so it SHALL resolve.

- **The not-found hint covers every pathed entity.** The known-paths sample
  sweeps only `file-*` localparts (`src/modules/prov/lineage.ts:141`), but
  documents also carry pathed `input-*` entities — a freshly-profiled
  analysis carries ONLY those — so the "Known files include:" hint renders
  empty precisely when a user most needs orientation. The sweep SHALL
  include every entity carrying an `inflexa:path`, whatever its QName scheme,
  consistent with the substring tier that already matches input entities.

- **Surface analysis-name ambiguity in prov commands.**
  `findAnalysisForProv` (`src/modules/prov/document.ts:581-583`) takes
  `rows[0]` from the newest-first candidate list, so `prov lineage a1`
  silently picks the newest of several same-named analyses. Prov commands
  SHALL fail on an ambiguous name/slug reference, listing the candidates
  with their ids and creation times so the user re-runs against an exact id.
  An exact-id reference stays unambiguous by construction.

- **Add `--format mermaid`: emit a Mermaid flowchart, no new dependency.**
  A pure text formatter over the same flat graph `json`/`dot` use, printing
  Mermaid `flowchart` source (entities as rounded nodes, activities as
  rectangles — the PROV visual convention; solid `wasGeneratedBy` vs dotted
  `used` edges). The CLI emits SOURCE only — like `dot`, the user pipes it
  to whatever renderer they like (mermaid.live, an editor preview, the
  `beautiful-mermaid` CLI for ASCII). This closes the "the tree can't show
  the real DAG" gap without pulling a layout engine into the CLI. `tree`
  stays the default; mermaid is opt-in.

## Capabilities

### New Capabilities

None — all four extend existing behavior of one command.

### Modified Capabilities

- `prov-lineage`: the unmatched-reference requirement gains the identifier
  tier and broadens the known-paths sample to all pathed entities; a new
  requirement adds the `mermaid` rendering.
- `cli-core`: the `inflexa prov lineage` registration gains `mermaid` in the
  `--format` surface, and the shared prov analysis resolution gains an
  ambiguity contract (fail-with-candidates instead of newest-wins) — the
  helper is used by `prov export`/`verify`/`verify-file`/`lineage`.

## Impact

- **Code**: `cli/src/modules/prov/lineage.ts` (the resolution tiers, the
  `fileEntities` sweep, a `formatMermaid` formatter, `--format` plumbing),
  `cli/src/modules/prov/document.ts` (`findAnalysisForProv`), the prov
  command actions that consume the resolver, `cli/src/cli/index.ts` (help
  text), and their tests.
- **Behavior**: no change for unambiguous references or existing formats;
  ambiguous names stop guessing; empty hints stop being empty; identifier
  refs and `--format mermaid` are additive.
- **Dependencies**: none — mermaid is emitted as source text.
