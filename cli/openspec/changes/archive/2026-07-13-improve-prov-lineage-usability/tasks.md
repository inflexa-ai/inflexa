## 1. Identifier resolution tier (design D1–D2)

- [x] 1.1 Add a final EXACT-IDENTIFIER tier to `resolveLineageRef` after the substring tier: match the ref against entity AND activity identifiers by full prefixed QName (tsprov `id` selector) and by bare localpart (`where: (r) => r.identifier?.localpart === ref`); an entity match → `kind: "files"` (that one info), an activity match → `kind: "activity"`
- [x] 1.2 Tests: `input-7ai1j57nqx1l` and `inflexa:input-7ai1j57nqx1l` both resolve the input entity; a command's QName resolves to an activity root; an exact path that also equals some localpart still resolves via the path tier (identifier tier never shadows an earlier tier)

## 2. Not-found hint covers every pathed entity (design D3)

- [x] 2.1 Change `fileEntities` (`lineage.ts:110`) from the `localpart.startsWith("file-")` matcher to "carries an `inflexa:path` attribute"; sample stays capped and deduped by path
- [x] 2.2 Test: an unknown ref in a profile-only document (only `input-*` pathed entities) yields a non-empty "Known files include:" hint listing the input path

## 3. Analysis-name ambiguity in prov commands (design D4)

- [x] 3.1 Add an ambiguity-aware analysis resolver in the prov module: exact-id match → that analysis; single row → that analysis; several rows none-by-id → `err({ type: "ambiguous"; candidates: {id,name,createdAt}[] })`; keep `not_found` for zero rows (built on `findAnalysesByRef`'s existing `(id=ref) DESC, created_at DESC` ordering)
- [x] 3.2 Wire the analysis-ref prov actions (`lineage`, `export`, `verify`) onto it; render the ambiguity via `fail()` listing each candidate's id, name, and creation time; `verify-file` untouched (takes a path)
- [x] 3.3 Tests: three same-named analyses → ambiguous failure listing all three; an exact id resolves despite name collision; a unique name resolves with no failure

## 4. `--format mermaid` source emitter (design D5–D6)

- [x] 4.1 Add `formatMermaid(graph, result)`: `flowchart LR` over the shared flat graph; deterministic grammar-safe node ids (QName → `_`-sanitized, kept in a `Map`, collision-free since QNames are unique); entities as rounded `id([label])`, activities as rectangles `id[label]`; labels carry the tree facts, quoted with Mermaid-significant chars escaped; edges `-->|wasGeneratedBy|` solid and `-.->|used|` dotted, exactly the JSON edge set
- [x] 4.2 Wire `--format mermaid` through `parseOptions` and the command registration (`src/cli/index.ts` help text `tree|json|dot|mermaid`); the unknown-format failure lists all four
- [x] 4.3 Tests: emitted source is a `flowchart` whose ids are grammar-safe and whose edge set equals `formatJson`'s edges; a shared intermediate appears as one node with several edges; a command label with `"`/`(`/`#` round-trips escaped (assert the structural invariants; a dev-only Mermaid parse check is optional and adds no runtime dependency)

## 5. Verification (round 1)

- [x] 5.1 `bun run typecheck`, `bun run lint`, `bun test` green from `cli/`
- [x] 5.2 `bun run format:file` on every touched file under `src/`
- [x] 5.3 Real-analysis smoke: the `input-…` identifier ref resolves; a profile-only unknown ref shows the hint; an ambiguous `a1` fails listing candidates; `--format mermaid` on the rich analysis pipes into a Mermaid renderer (e.g. the `beautiful-mermaid` CLI) and parses

## 6. Ambiguity-listing refinements (design D4 additions)

- [x] 6.1 Move `resolveAnalysisForProv`/`requireAnalysisForProv` (and `ProvAnalysisRefError`) from `document.ts` to `prov.ts` — `document.ts` stays the tsprov-speaking layer with no CLI-boundary or db-resolution concerns; update the three action imports
- [x] 6.2 Candidate lines gain the anchor folder's last-known path: one LEFT-JOIN query in `db/primary_query.ts` (analyses → anchors on `anchor_id`, selecting `cached_path` nullable), consumed by the resolver; a missing anchor renders a placeholder (normal desync, never an error)
- [x] 6.3 Candidate timestamps use `toLocaleString()` (the `analysis/ls.ts` formatting), not ISO
- [x] 6.4 Tests updated: candidates carry `{id, name, createdAt, anchorPath|null}`; a candidate with a deleted anchor row still lists with the placeholder; existing resolver tests keep passing

## 7. Verification (round 2)

- [x] 7.1 Gates green from `cli/`; `format:file` on touched files
- [x] 7.2 Real smoke: ambiguous `a1` now lists path + local time per candidate
