## 1. Traversal module

- [x] 1.1 `src/modules/prov/lineage.ts`: one-pass graph index over the deserialized+unified document — generation/usage maps (both directions), `wasInformedBy` map, element-attribute map (design D3)
- [x] 1.2 Reference resolution: exact path (all matching entities), exact hash, unambiguous hash prefix (≥6 chars); ambiguous prefix and no-match failures with candidates/sample (design D2)
- [x] 1.3 Backward walk (entity → generator activity → used entities, recursing) with activity context (command/exitCode, tool, step+run via `wasInformedBy` or step attrs) and terminal-input / no-recorded-inputs handling (design D5)
- [x] 1.4 Forward walk (entity → using activities → generated entities) (spec: forward lineage)
- [x] 1.5 Visited-set cycle marking and `--depth` truncation marking (design D4)
- [x] 1.6 Formatters: `tree` (per-entity lineage, hash-labeled multiplicity) and `json` (flat `{roots, nodes, edges}` in PROV semantics) (design D6)

## 2. CLI wiring

- [x] 2.1 Register `prov lineage <analysis> <file>` with `--forward`/`--depth`/`--format` in `src/cli/index.ts`, lazy-importing `runProvLineage`
- [x] 2.2 Action boundary in `lineage.ts`: analysis resolution (`findAnalysisForProv`), stored-document load, `dieOn`/`fail` handling, "no provenance recorded" failure

## 3. Tests and verification

- [x] 3.1 `src/modules/prov/lineage.test.ts` over documents built with the REAL builders: intra-step chain, cross-run prior read, leaf file, file-tool generation, forward walk, multiplicity (same path two hashes), hash-prefix resolution + ambiguity failure, self-read cycle, depth cutoff, JSON shape
- [x] 3.2 `bun run format:file` on changed src files; `bun run typecheck`; `bun run lint`; full `bun test` pass
