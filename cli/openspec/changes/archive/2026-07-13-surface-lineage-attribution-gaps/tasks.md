## 1. Record the gap (document builder)

- [x] 1.1 In `appendCommandExecuted` (`src/modules/prov/document.ts`), stamp `inflexa:unresolvedScript: <scriptPath>` on the command activity when `scriptPath` matches neither the group's outputs nor its inputs; keep the no-dangle skip (no entity, no `used` edge); resolved scripts unchanged
- [x] 1.2 Builder tests (`prov.test.ts`): unresolvable script → attribute present, no entity/edge; resolvable script → edge as before, no attribute; double append of the same event → one activity record with the attribute once (dedup under `unified()`)

## 2. Read the gap (lineage projection)

- [x] 2.1 Extend `LineageActivity` with `unresolvedScript?: string` and read it in `activityMeta` via `firstAttr` (`src/modules/prov/lineage.ts`)
- [x] 2.2 Expose the field on activity nodes in `formatJson`; append a gap marker to activity labels in `formatDot`/`formatMermaid` (both derive from the flat projection)

## 3. Word the absence kinds (tree rendering)

- [x] 3.1 In `formatTree`, branch the empty-input label on activity kind: `file_tool` → positive agent-authored wording ("agent-authored — no file inputs by design"); `command` → keep "no recorded inputs"; step-grain wordings untouched
- [x] 3.2 Render an activity's `unresolvedScript` as a child line beneath the activity, visually distinct from input files (marked unattributable, not a `(hash …)` file line)
- [x] 3.3 Trailing note: count `unresolvedScript` occurrences among activities the render visited (skip any whose script `used` edge is present — the edge is the stronger claim) and print one footer note when the count is > 0; no note at zero
- [x] 3.4 Lineage tests (`lineage.test.ts`): the three wordings; inline gap line + footer count; zero-gap walk prints no note; a document without the attribute renders byte-identical to today's output

## 4. Gates

- [x] 4.1 `bun run typecheck`, lint, full cli test suite green; `bun run format:file` on touched `src/` files
- [x] 4.2 End-to-end sanity: build a fixture document with one resolved script, one unresolved script, and one file-tool write; `prov lineage` tree shows the three absence kinds distinctly and `--format json` carries the gap field
