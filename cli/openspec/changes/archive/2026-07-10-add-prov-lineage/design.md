## Context

Every file entity in an analysis's PROV document has exactly one generation edge (`wasGeneratedBy(file, command)` from the command generation authority, or `wasGeneratedBy(file, step)` for leaf files), every command activity carries `used` edges for its command-scoped reads (including resolved intra-step self-reads), steps carry `used` edges for step-level reads, and `wasInformedBy` links command → step → run. File entities are keyed on `(path, hash)` in one shared QName space, so cross-run reads merge onto the producing run's entity under `unified()`. A backward walk is `file → wasGeneratedBy → activity → used → inputs → recurse`; forward is the same walk with edges reversed. The stored column bytes are the `unified()` serialization; `ProvDocument.deserialize` round-trips them, and tsprov exposes typed record enumeration (`getRecords(ProvGeneration)`, …) plus formal-attribute accessors (`PROV_ATTR_ENTITY`, `PROV_ATTR_ACTIVITY`, …).

## Goals / Non-Goals

**Goals:**

- Answer "where did this file come from?" (and "what came from this file?") from the CLI, over the graph as recorded — pure read, no new storage, **no new dependencies**.
- Surface multiplicity honestly: several entities sharing one path are several lineages; an ambiguous hash prefix is an error listing candidates; a cycle or depth cutoff is marked, never silently truncated.

**Non-Goals:**

- The `dot` output format (descoped by the requester; a later pure-text formatter if ever wanted).
- Fixing the recording gaps the walk will expose — `read_file` tool-reads emit no `prov.input_used`, `recordFileToolWrite` is uncalled, and per-input `wasDerivedFrom` edges are unemitted. All are harness-side (or builder changes with their own blast radius); the command documents that absent inputs may mean "not recorded", not "no inputs".
- A TUI lineage view or palette entry — the TUI design system owns new surfaces; this lands the CLI capability the issue asks for.
- Any general PROV query language; this is the one walk the substrate exists to serve.

## Decisions

**D1 — `prov lineage <analysis> <file>`, mirroring the existing `prov` shape.**
The issue sketches `lineage <path|hash>` with no analysis argument, but every `prov` subcommand takes `<analysis>` (a document is per-analysis and the resolver is id-or-name) — consistency wins. `--forward`, `--depth <n>` (default unbounded, per the issue), `--format tree|json` (default `tree`).

**D2 — Reference resolution: exact path, exact hash, or unambiguous hash prefix.**
Candidates are the `inflexa:file-*` entities (attributes `inflexa:path`/`inflexa:hash`). An exact path match may yield several entities (same path re-written across runs) — ALL are walked, each labeled with its hash, because they genuinely are distinct entities. An exact hash likewise may match several (identical bytes written at two paths are two `(path, hash)` entities) — also all walked. A hash PREFIX (≥ 6 chars) resolves when it matches exactly one entity and fails listing the candidates otherwise — hashes are long, and forcing full hashes would make the command unusable by hand. No match fails with a sample of known paths so the user can orient without exporting the document first.

**D3 — Index once, walk pure.**
The action deserializes the stored bytes (the same read `export` uses), applies `unified(PROV_UNIFY_OPTIONS)` as defense in depth (the column already stores unified bytes), then builds plain maps in one pass over the typed records: generation edges by entity and by activity, usage edges by activity and by entity, `wasInformedBy` by informed activity, and element attributes by QName. The walk recurses over the maps; formatting consumes the walk's tree. Everything below the CLI boundary is pure and unit-testable over documents built with the REAL builders (`appendCommandExecuted`, `appendFileWritten`, `appendInputUsed`, …) so the traversal is tested against exactly the record shapes production writes.

**D4 — Cycle and depth handling: mark, don't hide.**
A command that writes and re-reads the same path within one registration yields `generates(X) ∧ uses(X)` — a real 1-cycle in the recorded graph. The walk keeps a visited set spanning the WHOLE walk (not one branch): each entity expands once, and any re-encounter — a diamond or a true cycle — renders as an explicit reference marker (`already shown` in tree) instead of re-expanding. `--depth` cutoffs render an explicit truncation marker, and a depth-cut entity is NOT marked visited so a shallower encounter elsewhere can still expand it. In the flat JSON graph, re-encounters dedup naturally (nodes are keyed by QName); only depth cutoffs survive, as `truncated: true` on nodes no path expanded. Silent truncation would read as "no further inputs", which is exactly the false answer a lineage tool must never give.

**D5 — Activity context rides each node, and step edges are labeled as their own grain.**
A generation's activity renders with what a human needs to trust the answer: the command line and exit code (`inflexa:Command`), the tool name (`inflexa:FileToolWrite`), or the step fallback — plus the owning step and run resolved through `wasInformedBy` (commands) or the activity's own `inflexa:runId`/`inflexa:stepId` attributes (steps). A step activity is BOTH a leaf-file generator and the holder of step-level `used` edges, so any walk through it connects all step reads to all step leaf-outputs — true only at step grain (membership), not at file grain. Rather than dropping that honest upper bound or presenting it as a per-file fact, step nodes are labeled `(step-grain)` and their empty-side claims are scoped ("no step-grain outputs"), keeping the two grains visually distinct. In JSON the structure itself carries the grain: the connection runs through a `kind: "step"` node.

**D6 — JSON is a flat graph, not a nested tree.**
`{ roots, nodes, edges }` with nodes keyed by QName (kind, path, hash, command, exitCode, tool, runId, stepId as applicable) and edges in PROV semantics (`wasGeneratedBy` entity→activity, `used` activity→entity) regardless of walk direction. Flat is cycle-proof, dedup-free, and lets scripts re-derive either direction; a nested tree would re-encode the walk's own traversal order as if it were data.

## Risks / Trade-offs

- [Recording gaps read as truth] a file whose inputs were read via `read_file` shows no inputs → the command's help and empty-input rendering say "no recorded inputs", and the design names the gap; fixing it is harness-side follow-up.
- [Same-path entities may confuse] users expect one answer per path → multiplicity is labeled with hashes and run/step context, and the exact-hash form gives a single-entity walk.
- [prov module grows a second concern] traversal beside recording → same module is right (it consumes the module's own QName scheme and document loader); a new file `lineage.ts` keeps the recorder untouched.

## Open Questions

_None — the issue's open items (dot format, recording gaps, TUI) are settled as non-goals above._
