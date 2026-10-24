# Notes

Measured in `harness/` on `feat/705-harness-tsconfig-strictness` at HEAD
789d7eab.

## 1.1 Re-baseline on 0.8.0

- Pins: `@inflexa-ai/oxlint-plugin` 0.8.0 and `@inflexa-ai/typecheck`
  0.8.0, both exact, in `package.json`; `bun.lock` records both. `oxlint`
  stays 1.85.0 and `oxlint-tsgolint` stays 7.0.2003.
- `bun run lint`: passes, zero reports.
- `bun run typecheck`: passes, zero errors.
- 0.8.0 drift: none. No new lint report under any rule and no new
  typecheck error. Cross-check against the packet's 0.7.0 numbers: with
  the flag off and the six rules on, 0.8.0 reproduces them exactly
  (`no-unsafe-argument` 78, `-assignment` 70, `-call` 47,
  `-member-access` 39, `-return` 19; `no-conditional-spread` 838, 738 of
  them in src non-test). No `off` entry was added for a 0.8.0 cause.

## 1.2 Mid-state worklist (groups 2-5)

`noUncheckedIndexedAccess` is on in `tsconfig.json`, and the six `off`
entries are gone from `oxlint.config.ts`. Both commands fail; the counts
below are the worklist.

### tsc (`bun run typecheck`): 1343 errors

- src non-test: 387
  - `src/report-render`: 294 (chart.ts 93, chart-renderers.ts 31)
  - `src/report-model`: 71 (production-resolver.ts 40, draft-operations.ts 21)
  - rest of src: 22, led by `src/tools/lib/impc-client.ts` (4)
- test files (`*.test.ts`): 954, across 52 files
- scripts: 2, both in `scripts/refresh-fixtures.ts`
- The program reaches `src` and `scripts/**/*.ts` under the flag: both
  carry errors. No `__fixtures__` file carries an error.

### lint (`bun run lint`): 1111 reports, all under the six rules

- `@inflexa-ai/no-conditional-spread`: 838 (738 in src non-test)
- `typescript/no-unsafe-argument`: 87
- `typescript/no-unsafe-assignment`: 77
- `typescript/no-unsafe-call`: 47
- `typescript/no-unsafe-member-access`: 41
- `typescript/no-unsafe-return`: 21

The no-unsafe family moved 253 → 273 against the packet baseline
(argument +9, assignment +7, member-access +2, return +2, call +0). The
movement is flag fallout, not plugin drift: with the flag off, the 0.8.0
counts equal the 0.7.0 baseline, and each added report sits on a
`T | undefined` that the flag created.

## Flag fallout under foreign rules (for #709)

Two preset rules this change does not own report only under the flag;
each message names a `string | undefined` or `number | undefined`
operand. Both are off behind #709 in `oxlint.config.ts` (the D5
pattern), so every report of this change's lint run sits under its six
rules. The parent carries both to #709.

- `typescript/restrict-plus-operands`: 29 (flag off: 0)
- `typescript/no-unsafe-unary-minus`: 1 (flag off: 0; the site is
  `src/report-render/figures/common.ts:606`)

## 2.1 Group-2 state (render and model layer)

Done. `src/report-render` is clean under the flag (0 errors, was 294), and
`src/report-model` followed in the same group (71 → 0). The completion record
is under "2.1 completion" below.

### What changed per file in report-render

- chart.ts: `figureStatistics` pairs declared statistics with resolved
  values through a local pairs list and the existing `missingPart` err;
  `deriveTransformedRows` carries name and column values together and
  walks `rows.entries()`; `deriveBox` and `deriveViolin` build one
  `lanes` record per group (name, shapes, values) instead of parallel
  arrays read by place; `deriveComposition` and `deriveFacets` narrow
  `resolved[0]` into `first` through the existing no-series refusal;
  `compositionCategories` walks the channel values and drops its
  rowCount parameter; `markCarrier` returns the carrier entry instead
  of a `-1` index; `sharedAxes` takes `horizontal` from the caller;
  `bandSeries` returns an `[EchartOption, EchartOption]` tuple;
  `splitByChannel` and the box lane walk iterate `values.entries()`;
  `topRows` carries the cell beside the index through the sort;
  `lowest`/`highest` return `number | undefined` and callers fall back
  with the defaults they already had (`?? 0` / `?? 1`, sharedRange
  folds the empty check); the histogram and violin helpers guard the
  empty or degenerate ends on their existing empty-skip paths;
  `quantileType7` collapses to the floor/ceil pair of the doc comment.
- chart-renderers.ts: `RenderApi.coord` and `RenderApi.size` now return
  `[number, number]`, the pair the chart runtime guarantees, and the
  cap loop reads a typed tuple table.
- render.ts: the metric run renders a `slice` of blocks; the run
  counter reads with `?.`.
- number-format.ts: `finiteValue`, `formatNumberCell`, and
  `selectNumberKind` accept an absent cell; `finiteValue` answers
  `null` for it; `boundForm` destructures the split parts with `""`
  defaults (split of a non-empty text always yields both, so the
  defaults are out of reach).
- figures/common.ts: `orderCategories` admits `Cell | undefined` as
  its element type; `orderQuickCategories` returns the categories as
  `Array<Cell | undefined>`; `categoryAxis` and `compareCell` accept an
  absent cell; `continuousScale` folds the empty check into the min/max
  walk with the same `{min: 0, max: 1}` default; `firstFreeLanes`
  coalesces tree reads to the fill seed (minus infinity).
- figures/dendrogram.ts, heatmap.ts, oncoprint.ts: the category lists
  and the cell keys admit the absent cell; `checkTree` narrows the root
  through its own fault path; the reverse walk iterates a reversed
  copy.
- figures/dotplot.ts, embedding.ts, forest.ts, gsea.ts, qq.ts,
  volcano.ts, label-room.ts, ma.ts, km.ts, lollipop.ts, dense.ts,
  manhattan.ts, locuszoom.ts, pca.ts, roc.ts, sankey.ts, upset.ts,
  equal-units.ts: presence checks on the module's existing skip or
  fault path, `?.` chains on row reads, and adjacent-pair walks over
  running locals instead of `index - 1` reads.

### New defaults (design D2 record)

- chart.ts `deriveTransformedRows`: a column value past the end reads
  as `null`, which drops the row like any absent value; the column maps
  over the same rows, so the read is out of reach.
- chart.ts `deriveViolin`: a density past the grid reads as `0` width;
  the densities map one-to-one over the grid.
- chart.ts `quantileType7` and figures/embedding.ts `quantile`: an
  empty or unrangeable array answers `NaN` / `0`, the pre-flag
  arithmetic result; every caller guards non-empty.
- chart.ts `binCounts`: no edge pair answers `[]` (no bins), and the
  bin count reads with `?? 0` over an array the fill seeded.
- chart.ts `histogramEdges`: no values answer `[]` (no edges); the
  caller refuses an empty column first.
- figures/common.ts `firstFreeLanes`: a tree read past the seeded
  bounds reads as the fill seed (minus infinity).
- figures/km.ts, gsea.ts, sankey.ts, manhattan.ts: a palette read is
  in range by the modulo; the coalesce names the chart ink, the first
  palette color, or the muted color.
- figures/locuszoom.ts `positionWindow`: an empty step ladder answers
  step `1`; the ladder is built from a flatMap of two non-empty lists.
- figures/locuszoom.ts `binColor`: an absent bin table answers the
  missing-r2 color, the module's own absence color.
- figures/gsea.ts `turns`/`crossesZero`: an absent neighbor names no
  turn (false); `crossesZero` keeps the pre-flag NaN comparison as
  true.
- figures/dotplot.ts `lowestOf`/`highestOf`: the documented zero/one
  empty answers, now carried by `?? 0` / `?? 1`.

### Residual for the rest of 2.1

The plan for the 71 errors, from the reading done mid-session (implemented as
recorded under "2.1 completion" below): `parseDelimited` narrows the header
and walks `records.slice(1)` plus `header.entries()`; `selectCell`
merges the range check into a presence check and folds the match
narrowing into the empty-match refusal; the projection replaces the
`in` check with a cell presence check; the derivation narrows the two
inputs with a refusal on the module's fail path; the prepare loop zips
each target with its read at the task source; `draft-operations` adds
`containerPath` and `index` to `Located` (populated by
`locateInBlocks`), walks `blocks.entries()`, folds the `getChildren`
and `setChildrenInBlocks` guards into their never-runs branches, and
`malformed` guards the first issue with a generic refusal detail;
`fixture-resolver` mirrors the `selectCell`, projection, and
 derivation fixes of `production-resolver`.

## 2.1 completion

Task 2.1 is done. `src/report-render` and `src/report-model` both hold zero
non-test errors under the flag.

### Files changed

- `src/report-model/production-resolver.ts` (40 errors → 0): `parseDelimited`
  narrows the header — an empty record list answers the empty table through the
  undefined-header branch — and walks `records.slice(1)` plus
  `header.entries()`; each field value reads once and lands only when present,
  which omits the key the way `parseJsonTable` and `parseParquet` already do.
  `selectCell` merges the row range check into a presence check on the read
  row, and folds the match narrowing into the empty-match refusal. The table
  projection reads the cell and keeps it when present, replacing the `in`
  check. The derivation refuses when either input is absent. Both prepare
  fan-outs zip at the task source: each task returns its path (or its target)
  beside its read, so the result walk holds no index reads.
- `src/report-model/draft-operations.ts` (21 errors → 0): `Located` gains
  `containerPath` and `index`, populated by `locateInBlocks`, which now walks
  `blocks.entries()`. `changeBlock`, `removeBlock`, `moveBlock`, and the anchor
  branch of `resolveDestination` read the container and index from the located
  value instead of slicing `path` and reading its last element. `getChildren`
  and `setChildrenInBlocks` fold the undefined block read into their existing
  never-runs branches. `malformed` guards the first issue.
- `src/report-model/fixture-resolver.ts` (10 errors → 0): mirrors the
  `selectCell`, projection, and derivation fixes of `production-resolver`.

### Helpers

None added. The row-select shape repeats across the two resolvers, but the
module header records that the fixture mirrors the production walk on purpose —
the fixture is the executable specification of the value tier — so the
duplication stays.

### New defaults and guards (design D2 record)

- `production-resolver.ts` `parseDelimited`: an undefined header answers the
  empty table (it replaces the `records.length === 0` check, same result). A
  field value the equal-length check could not reach is skipped, so the key is
  omitted rather than written `undefined`; the branch sits behind the length
  check and matches the adjacent parse walks.
- Both resolvers, derivation: absent inputs answer a `locator-out-of-range`
  refusal that names the op and the input count held. The grammar pins `inputs`
  at length two (`DerivationReferenceSchema`), so the branch never runs; the
  refusal rides the module fail path, and no new throw serves the flag.
- `draft-operations.ts` `malformed`: an issue-less `ZodError` answers the
  generic refusal `the block does not match the draft grammar`. A `ZodError`
  always carries at least one issue, so the branch never runs.
- `draft-operations.ts` `getChildren` / `setChildrenInBlocks`: an undefined
  block at a container step takes the existing never-runs branch (empty
  children / unchanged blocks). Container paths come from `locate()` results,
  so each step names a section.

### Test results

- `bun test src/report-model/test/`: 306 pass, 0 fail, across 11 files. There
  is no `fixture-resolver.test.ts`; `production-resolver.test.ts` exercises the
  fixture resolver beside the production one.
- `src/report-render` is untouched by this half, so the `chart.test.ts` re-run
  was skipped; the previous run left it green.
- `bun run format:file` ran on the three changed files.

### Counts after this half

- `src/report-model` non-test: 71 → 0. `src/report-render` non-test: still 0.
- Whole-program `tsc`: 978 errors, all in the groups that are still open
  (rest-of-src non-test 22, tests 954, scripts 2).

## 3.1 Group-3 state (rest of src and scripts)

Done. The 22 src non-test errors outside report-render/report-model and the 2
`scripts/refresh-fixtures.ts` errors are fixed. `bunx tsc -p tsconfig.json
--noEmit` now reports no error outside `src/**/test/` and `src/**/__tests__/`.

### Files changed

- `src/lib/host-concurrency.ts` (3 errors → 0): `DEFAULT_LIMITS.default` read as
  `number | undefined` under the flag; the fallback is now the named
  `DEFAULT_HOST_LIMIT` constant that the record's `default` entry and the `??`
  coalesce share (same value 4, one source).
- `src/runtime/connection-budget.ts` (1 → 0): `rows[0]?.max ?? "0"`.
- `src/sandbox/estimate-data-profile-resources.ts` (3 → 0): the largest-file walk
  became `files.reduce` without a seed (element type, no `undefined`); totalBytes
  is a second seeded `reduce` over the same bounded list.
- `src/state/plans.ts` (1 → 0): `parent.rows[0]?.analysis_id`.
- `src/tools/approval/uuidv7.ts` (2 → 0): the version and variant nibble patches
  read and write through `readUInt8`/`writeUInt8` at the byte offsets instead of
  index access on the buffer.
- `src/tools/lib/chembl-client.ts` (2 → 0): `searchCompoundsByTarget` narrows the
  first target through a named local and the existing `return []`; the
  target-name fan-out coalesces the batch read to `null`.
- `src/tools/lib/clinical-benchmarks-client.ts` (1 → 0): `BenchmarksFile.phase_transitions`
  is now `Record<string, PhaseTransitions> & { all: PhaseTransitions }`, so the
  type carries the invariant the module-load guard already certified.
  `getBenchmarks` reads the requested area once and coalesces to the typed `all`
  baseline; the old `useFallback`/`ta` pair and its `therapeuticArea!`
  assertion are gone (the `!` population only shrinks).
- `src/tools/lib/ensembl-client.ts` (2 → 0): the single-symbol branch guards
  `symbols.length === 1 && singleSymbol !== undefined` on one destructured
  local; an empty symbol list still falls through to the batch POST as before.
- `src/tools/lib/impc-client.ts` (4 → 0): `doc === undefined` folds into the
  existing `return null` absence path of `resolveImpcGene`.
- `src/tools/report-session/list-artifacts.ts` (3 → 0): `readHeaderLine`
  destructures the split with an out-of-reach `""` default; `describe` reads the
  pinned record through the existing `snapshotEntry` helper of
  `reference-resolver`, so the lookup obeys the shared `Object.hasOwn`
  membership rule.
- `scripts/refresh-fixtures.ts` (2 → 0): the replay walk iterates
  `Object.entries(manifest)` sorted by key, and `rewritten` holds
  `[file, entry]` pairs, so the `capturedAt` write touches the entry object the
  walk read — no second index read anywhere in the loop.

### New defaults (design D2 record)

- `connection-budget.ts`: an absent `max_connections` row reads as `"0"`, which
  fails the budget check below and throws the module's existing FATAL, so boot
  aborts on the module's own failure path. The query returns exactly one row,
  so the branch never runs.
- `chembl-client.ts`: a batch name read coalesces to `null`; `names` comes from
  `Promise.all(batch.map(fetchTargetName))` over the same batch that `idx`
  walks, so the read is in range by construction, and `null` is the field's own
  unset value.
- `list-artifacts.ts` `readHeaderLine`: the `""` destructuring default is out of
  reach — a split with a limit of 1 always yields one element (same pattern as
  `number-format.ts` `boundForm` in group 2).

### Test results

- `bun test` over the ten test files that cover the touched modules:
  111 pass, 1 skip (the live-key-gated Ensembl integration test), 0 fail.
  Files: `runtime/test/connection-budget.test.ts`,
  `sandbox/test/estimate-data-profile-resources.test.ts`,
  `state/test/plans.test.ts`, `tools/approval/test/gateway.test.ts`,
  `tools/lib/test/chembl-client.fixtures.test.ts`,
  `tools/lib/test/impc-client.fixtures.test.ts`,
  `tools/lib/test/bgee-client.ensembl.fixtures.test.ts`,
  `providers/integration/test/ensembl.integration.test.ts`,
  `tools/report-session/test/list-artifacts.test.ts`,
  `tools/test/detail-resolver.test.ts`.
- `src/lib/host-concurrency.ts` has no dedicated test file; its `withHost` seam
  has none on the branch either before this change. No test was added (out of
  task scope).
- `bun run format:file` ran on the ten changed `src/` files.

### Counts after this group

- Whole-program `tsc`: 954 errors, all in test files (`src/**/test/` and
  `src/**/__tests__/`). Non-test, non-report errors: 0. Scripts: 0.

## 4.1 (partial)

Six of the 52 test files are clean under the flag. Whole-program `tsc`:
954 → 504 errors, all still in test files.

### Files completed (errors before → after)

- `src/report-render/test/render.test.ts`: 140 → 0 (183 tests pass)
- `src/report-render/test/chart-grammar.test.ts`: 74 → 0 (77 pass)
- `src/report-render/figures/test/heatmap.test.ts`: 71 → 0 (27 pass)
- `src/report-render/figures/test/gsea.test.ts`: 56 → 0 (22 pass)
- `src/report-render/test/chart-export.test.ts`: 55 → 0 (37 pass)
- `src/report-model/test/validate.test.ts`: 54 → 0 (85 pass)

Each file ran `bun run format:file` and `bun test <file>` green before the
next file started. `bun test` ran once per file, with no red run.

### Added `!`

- Count for this run: 0. Every site narrowed or restructured. The permitted
  use stays as design D2 states: in test files a `!` holds only where the
  read's target is constructed in the same test or expression; everything
  else narrows. #706 sweeps whatever `!` population remains at the end of 4.1.

### Idioms used

- Test-setup guard: `const x = list[0]; if (x === undefined) throw new
  Error("...")` where a test dereferences a read several times (render,
  heatmap, gsea, chart-export). The thrown message names the missing
  fixture piece.
- Shared narrowed-read helper where a lookup shape repeats: `firstSeries` /
  `firstMap` (chart-grammar), `firstInterval` / `firstOutline` /
  `secondSeries` (gsea), `firstGrid` / `columnAt` / `mountAt` (render grid
  tests), `firstDataAsset` (render), `provenanceAt` (render provenance),
  `firstFailure` (validate), `vectorAt` (chart-export). Each throws on the
  absent read and returns the narrowed element.
- `?.` chain where the subject lands in `expect(...)` and the assertion
  fails on `undefined`: `expect(series[0]?.large).toBeUndefined()` keeps its
  strength only beside a length or name assertion that pins the entry; the
  weak form (toBeUndefined on an optional-chained read) was avoided — those
  sites use a helper or guard instead.
- Out-of-reach coalesce on a mandatory regex capture: `match[1] ?? ""` where
  the group must participate for the match to exist (render `styleReferences`
  / `attributeReferences` / `itemRules` / `statValueRules`; heatmap
  `matrix[i]?.[j] ?? 0` over the square literal built from the same name
  list).
- Tuple result types on the test's own SVG-walk helpers: `boxesOf` returns
  `Array<[number, number, number, number]>` and `verticalInk` returns
  `Array<[number, number, number]>` (chart-export), and gsea `drawn` returns
  `Array<[number, number, ...number[]]>` — the helpers already guaranteed
  the member count, so the type carries it and the index reads stay `number`.
- `expectInvalid` companion: validate.test.ts gained `firstFailure(invalid)`
  beside the existing `expectInvalid`; every `(invalid.resolutionFailures ??
  [])[0].failure.X` read goes through it.

### New defaults (design D2 record)

- render.test.ts `runSpy.place`: a rank past the end of the `next` list
  leaves the section at its place; the callers pass one top per section.
- render.test.ts `runSpy.intersect`: an absent entry of the visibility list
  reads as not intersecting.
- gsea.test.ts `drawn` peak walk: `Math.abs(point[1])` over the tuple type —
  no numeric default. The heatmap distance table coalesces an absent cell to
  `0`, out of reach because the matrix literal is square over the same name
  list.

### Remaining for 4.1

The 504 errors sit in 46 files. Largest, by the live run at the end of this
half: figures/test/locuszoom.test.ts (37), figures/test/embedding.test.ts
(35), test/chart-renderers.test.ts (31), figures/test/km.test.ts (29),
gallery/test/gallery.test.ts (27), figures/test/volcano.test.ts (26),
figures/test/qq.test.ts (26), figures/test/manhattan.test.ts (25),
figures/test/forest.test.ts (24), views/test/values.test.ts (21), the rest
smaller. Same idioms apply.

## 4.1 (partial, second half)

Eleven more test files are clean under the flag. Whole-program `tsc`:
504 → 203 errors, all still in test files (35 files).

### Files completed (errors before → after)

- `src/report-render/figures/test/locuszoom.test.ts`: 37 → 0 (25 pass)
- `src/report-render/figures/test/embedding.test.ts`: 35 → 0 (14 pass)
- `src/report-render/test/chart-renderers.test.ts`: 31 → 0 (14 pass)
- `src/report-render/figures/test/km.test.ts`: 29 → 0 (20 pass)
- `src/report-render/gallery/test/gallery.test.ts`: 27 → 0 (8 pass, 28 skip
  on the pre-existing gallery-data gate)
- `src/report-render/figures/test/volcano.test.ts`: 26 → 0 (20 pass)
- `src/report-render/figures/test/qq.test.ts`: 26 → 0 (14 pass)
- `src/report-render/figures/test/manhattan.test.ts`: 25 → 0 (35 pass)
- `src/report-render/figures/test/forest.test.ts`: 24 → 0 (26 pass)
- `src/report-render/views/test/values.test.ts`: 21 → 0 (40 pass)
- `src/report-render/figures/test/upset.test.ts`: 20 → 0 (18 pass)

Each file ran `bun run format:file` and `bun test <file>` green before the
next file started. No red run in this half.

### Added `!`

- Count for this run: 0. Every site narrowed or restructured. The permitted
  use stays as design D2 states: in test files a `!` holds only where the
  read's target is constructed in the same test or expression; everything
  else narrows. #706 sweeps whatever `!` population remains at the end of 4.1.

### Idioms used

- Shared narrowed-read helpers where a lookup shape repeats, each throwing on
  the absent read and returning the narrowed element: `firstSeries` /
  `firstAxis` / `firstOf` (locuszoom, embedding, km, gallery, volcano, qq,
  manhattan), `firstDataItem` and `r2Of` (locuszoom), `axisAt` (upset),
  `yAxis(option, index)` (forest), `childAt` (chart-renderers), and
  `entryAt` (values, typed over the imported `ColumnDisplay`). `firstOf`
  takes `readonly T[]`, so it also serves `source.series`.
- Test-setup guard on a destructured read: `const [down, up, ns] =
  seriesOf(...); if (down === undefined || ...) throw` (volcano, qq,
  embedding, forest, km, manhattan). The thrown message names the missing
  piece.
- Tuple types carry the pair invariant that the chart construction gives:
  `segmentsOf` returns `Array<[number, number, number, number]>` and the
  outline polygon points read as `Array<[number, number]>` (chart-renderers);
  the leader lines read as `Array<[{ coord: number[] }, { coord: number[] }]>`
  (volcano, manhattan); `item.value as [number, number]` for the placed name
  points (volcano, manhattan); the dendrogram edge `coords` pair (gallery);
  the locuszoom gene spans as `Map<string, [number, number]>` (gallery). Each
  rewritten cast keeps the cast the line already had.
- Out-of-reach coalesce on a mandatory read: `match[5] ?? ""` on the regex
  stroke group (chart-renderers `segmentsOf`), `Number(span?.toFixed(3))` and
  `Number(width?.toFixed(6))` over the two-member band pairs (km, qq), and
  `summary.sets[place]?.name` inside the expected tuple (upset, where an
  out-of-range place fails the assertion).
- `?.` where the read lands in `expect(...)` or `JSON.stringify(...)` beside
  an assertion that pins the entry: the page-compare loops over
  `source.series.entries()` (locuszoom, gallery, volcano, manhattan),
  `series[0]?.markLine` (qq), and `inline[index]?.data`.

### New defaults (design D2 record)

- chart-renderers.test.ts `stubApi`: a dimension or coordinate member the
  item vector does not hold reads as `Number.NaN`, the value an absent point
  carries into arithmetic; the renderers read only the dimensions that their
  encode declares.
- chart-renderers.test.ts `segmentsOf`: an absent stroke group matches no
  segment (`match[5] ?? ""`; the group must participate for the match to
  exist).
- manhattan.test.ts zoom walk: a `convertToPixel` pair that misses a member
  aborts the walk with a thrown message; the echarts call returns the pixel
  pair of the point it got.

### Remaining for 4.1

The 203 errors sit in 35 files. Largest, by the live run at the end of this
half: test/chart-distributions.test.ts (19), figures/test/pca.test.ts (19),
figures/test/oncoprint.test.ts (16), test/chart-toolbox.test.ts (15),
sandbox/test/k8s-client.test.ts (12), figures/test/ma.test.ts (12),
test/hybrid-svg.test.ts (10), figures/test/roc.test.ts (10),
test/chart.test.ts (9), the rest smaller. Same idioms apply.

## 4.1 (completion)

Task 4.1 is done. The last 203 test-file errors went to zero, and `bun run
typecheck` passes with zero errors program-wide (src, scripts, and every test
file).

### Files completed this half (errors before → after)

- `src/report-render/test/chart-distributions.test.ts`: 19 → 0 (20 pass)
- `src/report-render/figures/test/pca.test.ts`: 19 → 0 (18 pass)
- `src/report-render/figures/test/oncoprint.test.ts`: 16 → 0 (17 pass)
- `src/report-render/test/chart-toolbox.test.ts`: 15 → 0 (35 pass)
- `src/sandbox/test/k8s-client.test.ts`: 12 → 0 (33 pass)
- `src/report-render/figures/test/ma.test.ts`: 12 → 0 (11 pass)
- `src/report-render/test/hybrid-svg.test.ts`: 10 → 0 (21 pass)
- `src/report-render/figures/test/roc.test.ts`: 10 → 0 (10 pass)
- `src/report-render/test/chart.test.ts`: 9 → 0 (148 pass)
- `src/report-render/figures/test/sankey.test.ts`: 7 → 0 (21 pass)
- `src/report-model/test/draft-operations.test.ts`: 7 → 0 (47 pass)
- `src/report-render/figures/test/dotplot.test.ts`: 6 → 0 (14 pass)
- `src/tools/report-session/test/record-version.test.ts`: 7 → 0 (20 pass)
- `src/report-render/figures/test/registry.test.ts`: 5 → 0
- `src/report-render/figures/test/lollipop.test.ts`: 5 → 0
- `src/report-model/test/block-walk.test.ts`: 5 → 0 (13 pass)
- `src/memory/test/conversation-display-recorder.test.ts`: 5 → 0
- `src/report-model/test/structural-validation.test.ts`: 4 → 0
- `src/report-model/test/production-resolver.test.ts`: 4 → 0
- `src/report-render/figures/test/label-room.test.ts`: 3 → 0
- `src/tools/report-session/test/list-artifacts.test.ts`: 2 → 0
- `src/tools/report-session/test/derive-table.test.ts`: 2 → 0
- `src/tasks/test/extract-values.test.ts`: 2 → 0
- `src/runtime/test/assemble.test.ts`: 2 → 0
- `src/report-render/test/table-data.test.ts`: 2 → 0
- `src/report-model/test/reference-stamp.test.ts`: 2 → 0
- `src/report-model/test/pin-snapshot.test.ts`: 2 → 0
- `src/app/test/chat-turn.test.ts`: 2 → 0
- `src/tools/display/test/normalize-echart-spec.test.ts`: 1 → 0
- `src/state/test/plans.test.ts`: 1 → 0
- `src/report-render/test/validity.test.ts`: 1 → 0
- `src/report-render/figures/test/common.test.ts`: 1 → 0
- `src/report-model/test/draft-read.test.ts`: 1 → 0
- `src/lib/test/chrome.test.ts`: 1 → 0
- `src/contracts/test/report-blocks.test.ts`: 1 → 0

Each file ran `bun run format:file` and `bun test <file>` green. The changed
files ran in two batches at the end: 497 tests across 19 files (one first-run
failure, the wrong `toHaveLength(3)` pin of block-walk, fixed to 4 and green on
the rerun) and 457 tests across 16 files, 0 fail.

### Added `!`

- Count for this run: 0. Every site narrowed, guarded, or coalesced. The diff
  holds four rewritten lines that keep a `!` each of them carried before this
  change (`name!` in label-room, `volumeMounts!` in k8s-client, `env!` twice in
  extract-values), and one pre-existing `!` left the tree (`stored!` in
  record-version, replaced by a null guard).
- TOTAL added-`!` count for task 4.1 across all runs: 0.
- The permitted use stays as design D2 states: in test files a `!` holds only
  where the read's target is constructed in the same test or expression;
  everything else narrows or restructures. #706 sweeps this `!` population when
  it turns on `typescript/no-non-null-assertion`.

### Idioms used (same families as the earlier halves)

- Shared narrowed-read helpers that throw on the absent read: `seriesAt`
  (chart-distributions), `firstSeries` / `firstGrid` (pca, roc),
  `firstTwo` (ma), `sectionBlocks` (draft-operations).
- Test-setup guards that name the missing piece (oncoprint, chart-toolbox,
  sankey, k8s-client, hybrid-svg, dotplot, record-version, structural-validation,
  common, table-data, assemble, chrome, plans, normalize-echart-spec,
  conversation-display-recorder).
- Tuple types that carry the invariant the construction gives: the markLine
  endpoint pair (chart-distributions), the cell triple `[x, y, class]`
  (oncoprint), the drawImage box and the four-capture `<image>` match
  (hybrid-svg). Each rewritten cast keeps the cast the line already had, beside
  the one new four-capture tuple cast in hybrid-svg.
- `?.` where the read lands in `expect(...)` beside an assertion that pins the
  entry, and a length pin (`toHaveLength`) restored where the follow-up
  assertion was a weak `toBeUndefined` (block-walk, twice).
- Out-of-reach coalesces on mandatory reads: the regex capture `match[1] ?? ""`
  (chart, validity), `expected[index] ?? 0` behind the equal-length assertion
  (chart-distributions), the announced-id `?? ""` inside `toEqual` (chat-turn,
  conversation-display-recorder), `names[index]?.text ?? ""` behind the
  one-placement-per-name contract (label-room), and
  `sorted[place - 1] ?? Number.NaN`, whose NaN comparison fails the assertion
  (label-room `clear`).

### New defaults (design D2 record)

- chart-distributions `medianLines` walk: an index past `expected` reads `0`;
  the walk sits behind `expect(lines).toHaveLength(expected.length)`, and a
  median of 0 fails `toBeCloseTo` for these slots.
- label-room `clear`: a neighbor past the sorted list reads `NaN`, so the gap
  test fails; `place === 0` short-circuits, so the read is in range.
- hybrid-svg crop walk: the four `<image>` captures read as a `[number, number,
  number, number]` tuple; a non-null match of the four-group pattern always
  holds them, and the null case takes the guard above it.
- dotplot term-duplicate row: the first term's name reads through a guard that
  names the empty table, because a `Cell` read past a `Record` narrows to
  `Cell | undefined` and the row literal must hold a `Cell`.

### Counts after 4.1

- Whole-program `bun run typecheck`: 0 errors (was 954 after group 3).
- Remaining for groups 5-6: the `no-unsafe-*` and `no-conditional-spread`
  reports of the live lint run.

## 5.1 (partial)

Task 5.1 is NOT complete. All 48 `no-unsafe-*` reports of `src` non-test are
fixed (verified: the live run reports none outside test files). 153 reports
remain, all under `src/**/test/`. `bun run typecheck` passes with zero errors.
The other rules of the run are unchanged: `no-conditional-spread` 838 (group
6), `no-unsafe-optional-chaining` 0 — five fires that the source typing
exposed in test files (dotplot.test 56, lollipop.test 90, chart-export 345 and
390, hybrid-svg 199) were fixed in the same pass with the chain hoisted into a
named local.

### Files changed (src non-test, reports before → after)

- `src/literature/sources/pubmed.ts` (21 → 0): the `any` of
  `xmlParser.parse` typed at the entry — `parseXmlRecord` returns
  `Record<string, unknown> | undefined` through an `isRecord` guard, and
  `childRecord`/`recordList`/`itemOf` walk the tree; `getItemValue` and
  `getAuthorsFromDocSum` now take `unknown`. The unused `DocSum` interface
  left the tree, and one `entry as Record<string, unknown>` cast became
  redundant and went with it.
- `src/state/runs.ts` (10 → 0): the row queries that feed reported reads carry
  `pool.query<Record<string, unknown>>`; `JSON.parse` in `mapRunRow` goes
  through an `isUnknownArray` guard.
- `src/lib/null-proto.ts` (new): `nullProtoRecord<T>()` — the three
  `Object.create(null)` sites (snapshot-parse, pin-snapshot,
  report-session-runtime) keep their null prototype and lose the parser `any`
  through an `unknown` intermediate and a guard that cannot refuse.
- `src/lib/unknown-array.ts` (new): `isUnknownArray(value): value is unknown[]`
  — `Array.isArray` alone narrows to `any[]`, which fed no-unsafe reports.
- `src/lib/zod-issues.ts` (1 → 0), `src/tools/lib/ctx-ops.ts` (1 → 0, flags
  filter through an `isString` guard), `src/tools/lib/openfda-client.ts` (1 →
  0), `src/input-scan/readout.ts` (1 → 0), `src/tools/display/
normalize-echart-spec.ts` (1 → 0), `src/tools/research/generate-plan.ts` (1 →
  0), `src/report-render/chart-renderers.ts` (2 → 0),
  `src/report-render/figures/dotplot.ts` (1 → 0, one `as unknown[]` cast left
  the tree), `src/report-render/chart.ts` (1 → 0),
  `src/report-render/figures/locuszoom.ts` (1 → 0: `LocusColumns` interface →
  type alias, so `Object.values` leaves its `any` overload), `src/loop/
run-agent.ts` (3 → 0: `jsonValue` returns `JSONValue` through an
  `isJsonValue` guard), `src/state/snapshot-parse.ts` (1 → 0),
  `src/report-model/pin-snapshot.ts` (1 → 0),
  `src/app/report-session-runtime.ts` (1 → 0).

### Files changed (tests, reports before → after)

- `src/report-render/test/render.test.ts` (27 → 0): page scripts run through
  `runWindowScript`/`runChartBootstrap`, which invoke the constructed
  `Function` with `.call` (TS 5.1 gives `Function` no call signature, so no
  annotation accepts it and a cast is banned); the arrayContaining assertion
  became two `toContain` assertions; the `?.`-into-cast chains of the toolbox
  test hoisted into locals.
- `src/report-render/figures/test/sankey.test.ts` (12 → 0): the
  `_unsafeUnwrap() ?? {}` fed `Object.values` its `any` overload; the test now
  refuses an undefined result and walks `single`/`double`. The regex-group
  reads carry the out-of-reach `?? ""` of the group-4 idiom.
- `src/state/test/data-profile.test.ts` (7 → 0): `pool.query<Record<string,
  unknown>>` plus the test-setup guard on the row read.
- `src/report-render/figures/test/manhattan.test.ts` (9 → 4): the
  `Object.fromEntries` maps annotate tuple callbacks (the array form falls to
  the `any` overload); the two constructed page functions invoke through
  `.call`; three arrayContaining assertions became `toContain` members.
- `src/report-render/test/chart-toolbox.test.ts` (5 → 4): the constructed page
  module invokes through `.call`.

### Residual worklist (153, all in test files)

`src/app/test/chat-turn.test.ts` 10, `src/report-render/test/
chart-renderers.test.ts` 7, `src/report-render/test/chart-grammar.test.ts` 7,
`src/loop/test/run-agent.test.ts` 7, `src/report-render/figures/test/
lollipop.test.ts` 6, `src/report-render/figures/test/gsea.test.ts` 6,
`src/tools/knowledge/test/knowledge-tools.test.ts` 5,
`src/report-render/figures/test/dotplot.test.ts` 5, `src/report-render/
figures/test/common.test.ts` 5, then the 4s (edit-file, chart-toolbox,
chart-export, chart-distributions, volcano, oncoprint, manhattan,
approve-plan), the 3s and 2s, and the 1s down to
`src/agents/sandbox/test/shared.test.ts`. The full per-site list is
`../tmp/pi/705-g5-final.txt`.

### Idioms for the remainder

- Constructed page functions: `new Function(...)` yields `Function`, which no
  signature accepts and no new cast may convert — invoke with
  `.call(undefined, ...)`, or wrap the common shapes in a per-file helper.
- `expect(x).toEqual(expect.arrayContaining([...]))` of literals trips
  no-unsafe-argument (bun-types `arrayContaining<E = any>`); `<string>` does
  not silence it — assert each member with `toContain`.
- `Object.fromEntries(x.map(...))` over plain arrays returns `any` — annotate
  the callback `: [string, unknown]` (`String(key)` is the same key
  `fromEntries` makes at runtime).
- An `EchartOption`/`Record` helper that returns `any` (untyped destructures,
  `seriesOf`-shaped walks) types at its declaration; `Object.values` over an
  `interface` falls to the `any` overload — iterate the members or use a type
  alias.
- Query rows in tests: `pool.query<Record<string, unknown>>` plus the
  test-setup guard.
- A `?.` chain that feeds `as T` and a member access trips
  no-unsafe-optional-chaining once the surrounding types are honest — hoist
  the read into a named local.

## 5.1 (partial, test files, first half)

82 of the 153 test-file reports are fixed. 71 remain, all under `src/**/test/`
(each file: format, lint zero on the five rules, `bun test` green). The added-`!`
count stays unchanged: this half added none — the two `!` on rewritten lines of
`run-agent.test.ts` sit on the same reads the removed lines carried.

### Files completed this half (reports before → after)

- `src/app/test/chat-turn.test.ts` (10 → 0): `contentText` walks an
  `isUnknownArray` guard; the three `expect.any(Number)` members of expected
  literals destructure the timing out and assert `toBeTypeOf("number")`; the two
  `Proxy` `get` traps route the narrowed `Function` through a typed local
  (`const fn: (...args: unknown[]) => unknown = value`) before `.bind`/`.call`;
  the role-and-id matrix asserts roles plus per-row `toBe` reads; the stream
  `data-compaction` lookup narrows the `ChatDataPart.data` record with
  `typeof`/`in` guards inside a `find`.
- `src/loop/test/run-agent.test.ts` (7 → 0): arrayContaining → per-member
  `toContain`; the exchange-id pair, the compaction parts, and the error fields
  read the timing member separately with `toBeTypeOf`; the exchange-tail and
  marker-tail `toEqual([..., objectContaining(...)])` arrays assert length plus
  per-member `toEqual`/`toMatchObject`.
- `src/report-render/test/chart-renderers.test.ts` (7 → 0): the constructed
  page module invokes through `.call(undefined)` (its `as` block predates the
  change); the error-bar styles carry their full literal (`stroke: CHART_INK`);
  three `objectContaining` arguments became `toMatchObject`.
- `src/report-render/test/chart-grammar.test.ts` (7 → 0): six
  `toEqual(objectContaining(...))` became `toMatchObject`; the series-builder
  page function invokes through `.call(undefined)`.
- `src/report-render/figures/test/lollipop.test.ts` (6 → 0),
  `gsea.test.ts` (6 → 0), `common.test.ts` (5 → 0), `dotplot.test.ts` (5 → 0),
  `src/report-render/test/chart-distributions.test.ts` (4 → 0),
  `chart-export.test.ts` (4 → 0, two page functions through `.call(undefined)`),
  `chart-toolbox.test.ts` (4 → 0), `src/report-render/figures/test/oncoprint
.test.ts` (4 → 0), `volcano.test.ts` (4 → 0, one page function through
  `.call(undefined)`, the three side styles read per member through a local
  `styleOf` guard), `src/tools/workspace/test/edit-file.test.ts` (4 → 0),
  `src/tools/knowledge/test/knowledge-tools.test.ts` (5 → 0).

### Idioms added to the working set

- `expect(x).toEqual(expect.objectContaining({...}))` over a typed receiver →
  `expect(x).toMatchObject({...})`; a nested `objectContaining` in the literal
  becomes a nested plain object (recursive subset match, same semantics).
- A matcher inside an expected literal (toEqual or toMatchObject) trips
  no-unsafe-assignment even under an `object` parameter — the nondeterministic
  member destructures out (`const { durationMs, ...rest } = part;`), the rest
  gets the exact `toEqual`, and the member gets `toBeTypeOf("number")`.
- `JSON.parse(...)` of a file the test itself wrote → a local `asRecord` guard
  (`typeof !== "object" || null || Array.isArray` + spread) returns
  `Record<string, unknown>`.
- An unknown-typed member read (`itemStyle`) narrows through the same
  guard-before-spread shape in a per-file helper.
- `new Function(...)` invocation: `.call(undefined)` keeps the pre-existing
  `as` block; the call signature of `Function` accepts no annotation.

### Residual worklist (71)

`manhattan.test.ts` 4, `approve-plan.test.ts` 4, `execute-analysis.test.ts` 3,
`generate-plan.test.ts` 3, `hybrid-svg.test.ts` 3, `chart.test.ts` 3,
`upset.test.ts` 3, `ma.test.ts` 3, `locuszoom.test.ts` 3, `heatmap.test.ts` 3,
then the 2s (`execute-command`, `define-tool`, `inspect-data-profile`,
`authoring-tools`, `template-binding`, `gateway`, `extract-values`,
`create-sandbox`, `validate`, `genai-spans`, `console-logger`) and the 1s down
to `src/agents/sandbox/test/shared.test.ts`. The live list is
`../tmp/pi/705-g5b-lint2.txt`. The other rules of the run are unchanged:
`no-conditional-spread` 838 (group 6).

## 5.1 (partial, test files, second half)

57 more reports are fixed across 25 files. 14 remain, all under `src/**/test/`, each a
single report. `bun run typecheck` holds zero errors program-wide, and the residual
lint run carries only the five-rule remainder plus `no-conditional-spread` 838 (group
6). The two foreign rules behind their #709 off entries (`restrict-plus-operands`,
`no-unsafe-unary-minus`) still report nothing.

### Files completed this half (reports before → after)

- `src/report-render/figures/test/manhattan.test.ts` (4 → 0): the arrayContaining
  assertions became per-member `toContain`; the two regex-member reads became
  `filter(...).length` / `filter(...)` beside the file's existing filter walk.
- `src/app/test/approve-plan.test.ts` (4 → 0): `runRows` and `threadRowCount` type
  their `pool.query<T>` rows at the source; the count read coalesces to `0` behind the
  count-returns-one-row invariant; the nested `objectContaining` argument became a
  nested plain object.
- `src/tools/test/execute-analysis.test.ts` (3 → 0) and `generate-plan.test.ts`
  (3 → 0): `expect.stringContaining` members left the expected literals — the refusal
  asserts `toMatchObject({ retryable: false })` plus `toContain` on the typed `error`
  member; the offered-tools assertions are per-member `toContain`; the model-authored
  record narrows with a `typeof`/`in` guard pair before the member read.
- `src/report-render/test/hybrid-svg.test.ts` (3 → 0), `chart.test.ts` (3 → 0),
  `figures/test/ma.test.ts` (3 → 0), `figures/test/locuszoom.test.ts` (3 → 0),
  `figures/test/upset.test.ts` (3 → 0), `figures/test/heatmap.test.ts` (3 → 0):
  constructed page functions invoke through `.call(undefined)` (each `as` block
  predates the change); `objectContaining`/`arrayContaining` arguments became
  `toMatchObject` / per-member `toContain`; the ma item styles read through a
  `styleOf` guard helper (the volcano shape).
- The 2s: `execute-command.test.ts` and `template-binding.test.ts` (JSON.parse of an
  own fixture → local `asRecord` guard, no cast), `define-tool.test.ts` (the two
  `@ts-expect-error` contract hooks keep their directives: the call hook annotates its
  parameter so the refusal rides the hook assignability, and the result hook wraps the
  access in `String(...)`; both keep the suppressed error and stay tsc- and
  lint-clean), `inspect-data-profile.test.ts` (the `stale` guard narrows before the
  typed `staleReason` read), `authoring-tools.test.ts` (find plus kind guard;
  `Array<ToolExecutionMode>(8).fill`), `gateway.test.ts` (the `expect.any(String)` id
  destructures out and asserts `toBeTypeOf`), `extract-values.test.ts` (`const
  parsed: unknown` before the `isUnknownArray` guard — the guard narrows only after
  the read), `create-sandbox.test.ts` (the spy declares its full
  `ReturnType<typeof spyOn<typeof dockerClient, "createDockerSandboxOps">>`),
  `validate.test.ts` (two `toMatchObject`), `genai-spans.test.ts` (arrayContaining →
  per-member `toContain`; the warn literal became one `toMatchObject` with a nested
  plain object), `console-logger.test.ts` (`asRecord` guard).
- The 1s: `web-fetch.test.ts` (the `stringContaining` header member asserts
  `toContain`), `pubmed.test.ts` (one `toMatchObject` with a nested plain object),
  `data-profile-resolve.property.test.ts` (per-member `toContain` over the unlisted
  members).
- `src/app/test/chat-turn.test.ts` (3 program `tsc` errors of the first half → 0;
  lint held at 0): the first half's typed-local-before-`.bind` idiom does not
  typecheck — `Function` assigns to no call signature. The working form is a
  `CallableFunction`-typed local before `.bind` (its special overload returns a typed
  function, not `any`), and the `query` branch reads the method off the proxied client
  (`inner.query(text, values)`) so nothing calls through `Function` at all.

### Added `!`

- Count for this run: 0. No new `as` cast, no new directive. The two
  `@ts-expect-error` lines of `define-tool.test.ts` predate the change and stay used.

### Residual worklist (14, one report each)

`src/state/test/report-versions.test.ts` (`Object.create(null)` assignment → the
`nullProtoRecord` helper of `src/lib/null-proto.ts`), `src/state/test/
reconcile-orphaned-runs.test.ts` (38:16 any return), `src/report-render/test/
table-data.test.ts` (120:9 Function call), `script-json.test.ts` (18:24 JSON.parse
assignment), `number-format.test.ts` (490:29 Function call), `gallery/test/
gallery.test.ts` (360:33 Function call), `figures/test/embedding.test.ts` (181:23
Function call), `src/report-model/test/production-resolver.test.ts` (592:13),
`src/memory/test/thread-store.test.ts` (748:25), `src/contracts/test/
report-blocks.test.ts` (551:49), `src/citations/test/resolve.test.ts` (251:21),
`src/citations/test/aggregate.test.ts` (102:44), `src/app/test/synthesize-run.test.ts`
(139:44), `src/agents/sandbox/test/shared.test.ts` (406:84). The live list is
`../tmp/pi/705-g5g-lint.txt`.

## 5.1 (completion)

Task 5.1 is done. The last 14 reports went to zero, one per file. `bun run typecheck`
holds zero errors program-wide, and the live lint run reports nothing under the five
`no-unsafe-*` rules; the residual is `no-conditional-spread` 838 (group 6), and the two
foreign rules behind their #709 off entries (`restrict-plus-operands`,
`no-unsafe-unary-minus`) still report nothing.

### Files completed this run (reports before → after, one each)

- `src/state/test/report-versions.test.ts` (298): the `Object.create(null)` record comes
  from `nullProtoRecord<{ hash; fileType }>()` (`src/lib/null-proto.ts`).
- `src/state/test/reconcile-orphaned-runs.test.ts` (38): `statusOf` types its
  `pool.query<Row>` rows at the source and guards the one-row read with a thrown message
  that names the run (the group-4 test-setup guard).
- `src/report-render/test/table-data.test.ts` (120), `number-format.test.ts` (490),
  `gallery/test/gallery.test.ts` (360), `figures/test/embedding.test.ts` (181): each
  constructed page function invokes through `.call(undefined)` (the embedding file holds
  one such site, not four; the live run and the file agree). Each `as` block predates the
  change and stays.
- `src/report-render/test/script-json.test.ts` (18): the `JSON.parse` round trip lands in
  a `const parsed: unknown` local before the `toEqual` — the extract-values shape, since
  no member read follows.
- `src/report-model/test/production-resolver.test.ts` (592): the batch of fall-through
  requests is asserted per member through `find` plus `toMatchObject`, order-free like the
  `arrayContaining` it replaces.
- `src/memory/test/thread-store.test.ts` (748): the `DbError | ThreadInputError` refusal
  narrows through a `type !== "constraint_violation"` guard whose throw names the actual
  variant; `constraint` then reads as the typed string and asserts `toContain`.
- `src/contracts/test/report-blocks.test.ts` (551): `toEqual(expect.objectContaining)` →
  `toMatchObject` on the narrowed first issue.
- `src/citations/test/aggregate.test.ts` (102): `toEqual([expect.objectContaining(...)])`
  → `toMatchObject([{ ... }])` (verified: bun's `toMatchObject` matches an array
  receiver against an array of subset objects and pins the length).
- `src/citations/test/resolve.test.ts` (251): the `find` lands in a named local; the
  plain members ride `toMatchObject` and the typed `detail` member asserts `toContain`.
- `src/app/test/synthesize-run.test.ts` (139): the embed stub builds each vector with
  `new Array<number>(1536).fill(0.01)` — the generic types the fill at the source.
- `src/agents/sandbox/test/shared.test.ts` (406): the `ToolError` refusal lands in a
  local; `toMatchObject({ retryable: false })` plus `toContain` on the typed `error`
  member (the execute-analysis shape).

### Idiom refinement for the record

bun's `toContain` is a strict-equality match on object members (verified against the
installed bun 1.4.2: `expect([{a: 1}]).toContain({a: 1})` fails), so the "per-member
`toContain`" conversion applies to primitive members only. An `arrayContaining` of
objects converts to per-member `find` (or indexed reads) plus `toMatchObject`, which
keeps the subset semantics and the order freedom.

### Added `!`

- Count for this run: 0. No new `as` cast, no directive. The `as` blocks beside the four
  `.call(undefined)` sites and the two `@ts-expect-error` lines of `define-tool.test.ts`
  predate the change.
- TOTAL added-`!` count for task 5.1 across all runs: 0.

### Final state of task 5.1

- `typescript/no-unsafe-argument`: 0. `-assignment`: 0. `-call`: 0.
  `-member-access`: 0. `-return`: 0.
- `bun run typecheck`: exit 0, zero errors program-wide (src, scripts, every test file).
- Residual of the live lint run: `no-conditional-spread` 838 (group 6, untouched).
- Each changed file ran `bun run format:file` and `bun test` green: 312 pass / 28 skip
  (the pre-existing gallery-data gate) / 0 fail across the 11 non-database files, and
  80 pass / 0 fail across the 3 database files.

## 6.1 (partial)

The live rule count is zero: `bun run lint` exits 0 with no
`@inflexa-ai/no-conditional-spread` report, and `bun run typecheck` holds
zero errors. `bun test` does not pass yet: 99 fails remain, all in the
same-module tests that assert true key absence. Task 6.1 stays unchecked.

### The conversion

- A codemod (`tmp/g6-codemod.ts`, scratch) converted 811 sites by AST
  classification that mirrors the rule: `cond ? Filled : Nothing` and
  `X && Filled` become the properties of `Filled`; `X ?? {}` and `X || {}`
  become `...X`. A second pass took the 4 nested/overlapping sites. The
  per-site classes: 792 with the direct form the rule message names, 39
  multiline or ambiguous, 7 `?? {}` fallbacks.
- Hand-written sites: `validate.ts` and `record-version.ts` (the D3-named
  observable-presence pair, if-form), `chart-view.tsx` (JSX,
  `style={bodyStyle === "" ? undefined : bodyStyle}`), the 15 ambiguous
  ternaries (per-key ternary, named-variable `Object.assign`, or
  value-position ternary), 2 sites in `scripts/refresh-fixtures.ts`.
- The codemod's first apply had a range bug (props replaced by themselves);
  only the 7 emptyFallback sites landed before the fix. The corrected apply
  covered the rest.

### Fallout the direct assignment caused, and the fixes

- ~124 tsc errors: the condition was also the type narrowing. Fixed with
  `?.` chains, value-position ternaries (`key: cond ? v : undefined`),
  `?? undefined` for `null`-carrying rows, and the if-form where the target
  type requires the key (`chart.ts plottedSeries`, `locuszoom.ts
  LocusColumns`, `defineTool` packaging).
- ~24 unused-variable lint errors: the condition was a real feature gate.
  Restored by if-form or per-key ternary: toolbox zoom features, heatmap
  `inverse`, km `onTick` max-label suppression, upset shown-count name,
  embedding first-panel key axis, `seriesItemStyle`, `formOptions`
  `large`/`largeThreshold`, `plottedChannel` retyped, `thinnedLabels`
  tooltip, the color-scale grid `right`, `libStoreEnv` cache dirs, dgidb
  attributes, inspect-run `summaryPath`/verbose fields and `selfWaitPrevented`,
  `normalizeEchartSpec` placement, pca point labels, `loopFields`
  model-authored fields, run-agent and execute-analysis usage rollups.
- Compound guards that carried logic beyond undefined-ness were restored
  with their condition: normalize identifiers `!identified`, readout
  `documents > 0` and the `isRecord` first-element keys, detect-sets
  `sameAs` slot gating, chat-turn failed/aborted note branches.

### The systematic finding (for the correction round)

This suite asserts true key absence pervasively — `not.toHaveProperty`,
`"key" in obj`, and wire/DB serialization contracts. For every conditional
spread whose key reaches a tested or serialized object, the direct
assignment leaves the key present with `undefined`, and the test refuses
it. 99 tests fail on that class across: memory (plan cards, thread-history
rows, display replay, recorder metadata), state (`tool-outputs.threadId`),
contracts (`subagent-activity.label`, `chat-frame.invocationId`),
app (`chat-turn storeError`), loop (run-agent attribution), sandbox
(`exec-outcome.syntheticFailure`, docker `platform`, mutator `threadId`,
k8s mounts), workflows (execute-analysis run-completed usage, sandbox-step),
tasks (data-profile partition math reads an `undefined` past a `?.`),
citations golden fixtures, and the render layer's nested-object gates
(manhattan zoom names, normalizeEchartSpec idempotence, bridge values,
preset expansion).

Two mechanical passes finish the class:

1. Nested-object values: where the filled object's value was itself an
   object literal (`itemStyle: {...}`, `markLine`, `axisLabel`,
   `lineStyle`, `binding`), the outer key needs the ternary/if-form — an
   always-present nested object fails `toEqual` even when its own keys are
   undefined. Fixed this run for: `seriesData` items, `markLine`,
   heatmap/dotplot `axisLabel`, pca/sankey/violin item objects, `turnUsage`,
   recorder `metadata`, `page-faults.omittedFaults`, `resource-limits.gpu`,
   knowledge `disputed`, ai-sdk `timeout`, inspect-run `wait`.
2. Top-level true absence: where a test or a serializer observes the key,
   the if-form (named mutable variable, or a named `cond ? { key } :
   undefined` field spread — never a conditional spread argument) must
   replace the direct assignment. Remaining sites are enumerable from the
   99 failing tests: run `bun test`, take each `not.toHaveProperty` /
   `"key" in` assertion, and gate its producing site.

Added `!`: 0 in src non-test. The `!` tokens inside the converted
expressions of `crossref.ts`/`doi-registry.ts`/`detect-sets.ts` are the
pre-change population moved with their lines, not new sites (the #707 sweep
owns them). No new `as`, no `@ts-expect-error`, no lint directive; the
`as` casts that predate the change stay, and one `as EchartOption` in
`figures/embedding.ts` was removed by the conversion.

## 6.1 (completion)

Task 6.1 is done. The last key-absence failures went to zero with the
named-variable if-form at each producing site. `bun run lint` exits 0, `bun run
typecheck` exits 0, and `bun test` holds 0 fail (6116 pass, 51 skip — the
pre-existing gallery-data gate; green on the first final run, confirmed on a
second full run).

### Producing files, restored keys, and the consumer that observes each

- `src/tools/workspace/result-bounds.ts`: `syntheticFailure` on
  `BoundedExecResult` — the durable step output of a workflow return (the module
  doc names the DBOS serialization), asserted with `"syntheticFailure" in r` in
  result-bounds.test.ts.
- `src/tools/workspace/execute-command.ts`: `provenance` and `recordWrites` on
  `ExecCallRecord` — the tool call record rides the durable session ledger and
  the test pins its exact shape with `toEqual`.
- `src/tools/workspace/edit-file.ts`: `decision_record_noted` on the
  `edit_file` `ok` outcome — a model-facing truth flag; the codemod had made it
  unconditional, which reported a noted decision record for a plain file. The
  ok branch moved to a named `EditFileOk` interface whose two optional members
  are mutable. `lines` stays a direct assignment: pure undefined-ness, no
  absence consumer.
- `src/tools/workspace/mutator.ts`: `threadId` on `WriteRecord` and on the
  `write-file` session event — the event is persisted and replayed to the
  display; asserted with `not.toHaveProperty("threadId")`.
- `src/tools/approval/gateway.ts`: `detail` and `reply` on the `data-ask` chat
  part — a reconciling wire part; asserted with `not.toHaveProperty("reply")`
  and the resolved-part reply read.
- `src/tools/knowledge/recommend.ts`: `dropped`, `unrealized`, `nearest`, and
  `reason` on `KnowledgeRecommendAnswer` — the planner answer, whose key set
  the test pins with `Object.keys` and whose doc states "Absent when none" for
  the first two. `situation` and `environment_source` stay direct: no absence
  consumer.
- `src/tools/lib/amass-client.ts`: `claims` and `description` on
  `PatentRecord` — the mapped provider record, asserted with
  `not.toHaveProperty` on both.
- `src/literature/sources/semantic-scholar.ts`: `title`, `abstract`, `year`,
  `venue`, `citationCount`, `url`, and `externalIds` on `SemanticScholarPaper`
  — the mapped provider paper; the fixture test states that a null field drops
  out of the mapped paper.
- `src/input-scan/templates.ts`: `prefix` and `suffix` on `DraftSlot` — the
  collapsed gate was truthiness, not undefined-ness, so an emptied affix
  (the all-digit and date guards write `""`) leaked the empty string into the
  slot. Absence is the "no affix" shape; asserted with `toBeUndefined()`.
  `width`/`minLength`/`maxLength`/`skeleton` stay direct: undefined-ness only.

### Collapsed conditions restored beyond the failing tests

- `mapPatentRecord` `claims` gate (only `description` had a failing test).
- The `decision_record_noted` truth bug is the one restore that changes
  behavior beyond key presence: the unconditional `true` would have reached the
  model for every non-script edit.
- The sweep of each producing file's full diff found no other dropped gate,
  swap, inverse, or fill-guard: the remaining direct assignments are
  function-argument objects (`env`, `timeoutSeconds`, `workingDir`, `logger`,
  `provenance` on `feedExecFrame`) where undefined and absent are the same to
  the callee, or undefined-ness gates with no absence consumer.

### One stale reference fixed beside the task

`src/loop/run-agent.ts` carried an unused `EventSource` type import — left
behind when the 6.1 conversion inlined the `source` structural type for the
if-form. The unused import failed `bun run lint` (`no-unused-vars`), so the
import left the tree in this change.

### Added `!`

Count for this run: 0. No new `as` cast, no `@ts-expect-error`, no lint
directive. The `as const` literals of the moved object literals predate the
change or sit beside an explicit type annotation that makes them redundant; the
two redundant ones left the tree.

### Open questions

None. Every absence assertion of this class names a real consumer — the
durable step output, the session event replay, the reconciling chat part, the
planner answer, the mapped provider records — so no test-only over-assertion
stayed unfixed.

### Final state

- `bun run lint`: exit 0, zero reports.
- `bun run typecheck`: exit 0, zero errors.
- `bun test`: 0 fail, 6116 pass, 51 skip (the pre-existing gallery-data gate).

## 7.1 final

All three gates pass, the emitted declarations are consumable from the cli, and
the acceptance-3 diff search against 789d7eab closes with one violation found
and fixed.

### Gates

- Format sweep: `bun run format:file` ran over all 279 changed `src` files (the
  `git diff --name-only 789d7eab` list); `bunx prettier --check` then passes on
  every one. No config or spec file was formatted.
- `bun run lint`: exit 0, zero reports (final run, after the probe restore and
  the oncoprint fix).
- `bun run typecheck`: exit 0, zero errors program-wide.
- `bun test`: first run 6115 pass / 51 skip / 1 fail —
  `src/providers/test/ai-sdk.request-timeout.test.ts` "does not cut a body that
  outlives the window, because the guard clears at the headers", a 30 ms guard
  window that fired under suite load. Re-run per the design's one-rerun rule:
  6116 pass / 51 skip / 0 fail (51 = the pre-existing gallery-data gate).
- `bun run build` (tsc build plus copy-assets): exit 0.
- Declaration consumability: `cd ../cli && bun run harness:local` exit 0
  (rebuild plus relink, the standard local-link state), then cli
  `bun run typecheck` exit 0 against the linked working-copy harness.
  `git status --short cli/` holds no tracked change.

### Foreign-rule probe (task 3 of 7.1)

The two `off` entries behind #709 came out of `oxlint.config.ts` for one lint
run, then went back byte-identical.

- `typescript/restrict-plus-operands`: 3 reports. Sites:
  `src/report-render/number-format.ts:499` (`grouped += digits[index]`) and
  `src/report-model/production-resolver.ts:338` and `:357` (`field += ch` over
  an `entries()` walk) — each a `string | undefined` operand the flag creates.
  Down from the 29 of the 1.2 mid-state: the group 2-6 fixes narrowed 26 of
  them incidentally while fixing the owned rules.
- `typescript/no-unsafe-unary-minus`: 0 reports. The one 1.2 site
  (`src/report-render/figures/common.ts:606`) left with the group-2 work on
  that module.
- Either rule still reporting means the entries stay: both were restored
  exactly, and `bun run lint` passes again after the restore. #709 owns the 3
  remaining `restrict-plus-operands` sites.

### Acceptance-3 diff search (against 789d7eab, `harness/src` and `harness/scripts`)

Pass 1 — added lines matching `as [A-Z]`, `@ts-expect-error`, `@ts-ignore`,
`oxlint-disable`: 89 hits.

- 87 pre-existing-moved: the identical cast or directive sits on a removed line
  of the same hunk. Most are the echarts union-shape family
  (`as EchartOption`, `as EchartOption[]`, `as Record<...>`) whose index read
  gained `?.` or a guard while the cast moved with its line, plus the 6.1
  conditional-spread conversions that moved a cast out of a ternary, and the
  two pre-existing `@ts-expect-error` contract hooks of `define-tool.test.ts`.
- Permitted, not moved: the two four-capture tuple casts of
  `hybrid-svg.test.ts` were misclassified here; correction round 1 records the
  corrected classification (see below): the :421 cast refines the baseline's
  own `as number[]` and stays, the :453 crop cast was new against the baseline
  and left the tree in correction round 1.
- Violation, fixed: `src/report-render/figures/test/oncoprint.test.ts`
  `cellClass` had refined the pre-existing cast to the `[number, number,
  number]` triple on module output, with no typed local or helper return type
  carrying it. Restored the baseline cast (`as Array<number[] | { value:
  number[] }>`, the removed line's own form) and narrowed the member read with
  a guard that names the cell. The file passes format, its 17 tests, and the
  program typecheck after the fix.

Pass 2 — added ` as ` with a lowercase target (tuples, primitives, `unknown`),
78 hits: prose matches (messages, comments) aside, each is a cast whose
identical form sits on a removed line of the same hunk (the `as number[]` →
`as [number, number]` refinements of the markLine and band pairs among them,
recorded under 4.1), except one: `src/tools/report-session/preview-report.ts`
adds `"rendered" as const` — the D3 named-variable restructure moved the
outcome literal out of the `ok(...)` argument position, and the assertion
carries the literal type of the discriminant into the standalone const. It
asserts no presence and silences no index-access error.

Pass 3 — added `!`: every `!` token on an added line sits on a removed line of
the same file (moved with the 6.1 conversion or the index-access restructure):
`formats[0]!` (data-profile-view), `parseYear(dateParts[0])!` (crossref,
doi-registry), `slotIds[slot.sameAs]!` (detect-sets), the
`stringValue(...)!`/`numberValue(...)!` family (list-available-refs),
`exchange!`/`running!`/`parts[0]!`/`messages[markerAt]!` (run-agent.test),
`replay[N]!` (chat-turn.test), `calls[0]!` (generate-plan.test), and the
recorded `name!`, `volumeMounts!`, and `env!` sites. No new site.

- TOTAL added-`!` count for the change across all runs: 0.
- The permitted use stays as design D2 states: in test files a `!` holds only
  where the read's target is constructed in the same test or expression;
  everything else narrows or restructures. #706 sweeps the remaining `!`
  population when it turns on `typescript/no-non-null-assertion`.

### Drift table for other children of #607

- 0.8.0 toolchain drift: none (recorded under 1.1 — no new lint report under
  any foreign rule and no new typecheck error at the re-baseline).
- `typescript/restrict-plus-operands` (#709): 3 reports under the flag, 0 with
  it off. Sites and operands under "Foreign-rule probe" above.
- `typescript/no-unsafe-unary-minus` (#709): 0 — resolved incidentally by the
  group-2 work; no entry change needed beyond the existing one.
- No other foreign rule reports on the final run: `bun run lint` exits 0 with
  the two #709 entries in place and no other `off` entry added by this change.

## Correction round 1

Review found collapsed gates and empty-value presence changes left by the 6.1
codemod at the sites below. Each site restores the baseline gate as a value
ternary (`key: cond ? value : undefined`) or as the if-form where a consumer
observes key presence. `exactOptionalPropertyTypes` is off, so `undefined` ≡
absent. No test was relaxed; no checkbox changed.

- `src/loop/continue-agent.ts:78` — `endsOnRequestRefusal` rode unconditionally
  `true`; restored the `request.endOnRequestRefusal === true` gate.
- `src/workflows/execute-analysis.ts:673` — `snapshot` reached
  `bindTemplateContract` for any value; restored the
  `snapshot && snapshot !== "none"` gate, so `"none"` never reaches the
  knowledge wire.
- `src/app/data-profile-view.ts:81` — `unclassified` was always `true`; restored
  the `group.unclassified` gate. The same-file collapsed truthiness gates beside
  it came back with it: `fromGroup` `format`, `kind.format`, and the two
  `description` gates.
- `src/app/data-profile-view.ts:130` — `format` dropped the single-format census
  gate; restored `group.formats.length === 1` (the pre-existing `!` on the
  element read stays).
- `src/citations/clients/pubmed.ts:14` — `doi` read `toLocaleLowerCase` off a
  possibly absent value, and `""` would ride as a real identifier
  (`identifierEntries` skips `undefined` but keeps `""`, which merges unrelated
  clusters); restored the `article.doi` truthiness gate, with the
  `title`/`authors`/`venue` falsy gates beside it. The reviewer's `sections`
  path label pointed here; the `sections` gate itself sits in
  `src/tools/bio/pubmed.ts:210` (restored: an empty section filter must not ride
  the full-text call).
- `src/tools/lib/clinical-trials-client.ts:376` — `ci_low`/`ci_high` lost the
  null and NaN checks; restored the full
  `!== undefined && !== null && !isNaN(parseFloat(...))` guards.
- `src/tools/research/generate-plan.ts:919` — `toolCallsTruncated` was always
  `true`; restored the `transcript.truncatedToolCalls` gate.
- `src/tools/research/generate-plan.ts:1213` — `rejectionsTruncated` was always
  `true`; restored the `trace.rejectedAttempts > trace.rejections.length` gate.
- `src/sandbox/package-identity.ts:239` — `version: ""` rode the parse result;
  restored the `version === ""` gate (`formatQuery` pins on
  `version === undefined`; the round-trip law the comment at :228 states).
- `src/runtime/assemble.ts:317` — the bio keys overrode a bound
  `citationResolverConfig`; restored the config-wins precedence:
  `ncbiApiKey: deps.citationResolverConfig?.ncbiApiKey ??
  conversation.bioKeys.ncbi`, and the `semanticScholarApiKey` twin.
- `src/tasks/data-profile-resolve.ts:197` — `completeness` rode for every group;
  restored the `expectedCompanions.length > 0` gate. Beside it, in the same
  literal: removed the `slots` entry that defeated the existing
  `if (slots.length > 0)` restore, and restored the `memberAnnotations` length
  gate and the `categoryLabel`/`subtype`/`categoryReason`/`reason` truthiness
  gates.
- `src/report-render/figures/pca.ts:271` — `symbol` rode for unshaped series;
  restored the `shapeKey !== undefined` gate.
- `src/report-render/figures/pca.ts:306` — `bottom: 0` rode on equal-units
  legends; restored `bottom: draw.equalUnits ? undefined : 0`.
- `src/tools/define-tool.ts:316` — `foldCallRecord` rode for every tool;
  restored the `typeof def.foldCallRecord === "function"` gate as the if-form on
  the packaged tool (key presence is the hook contract the comments state).
- `src/tools/sandbox/list-available-refs.ts:536` — restored the four
  `stringValue` truthiness gates (`datasetId`, `category`, `subtype`,
  `organism`), with the fifth (`endpoint`) and the nested `dataset.organism`
  gate of the same hunks.
- `src/tools/research/inspect-run.ts:83` — the verbose `error` coalesced `null`
  to `undefined`; restored the null form (`r.error ?? null`), and the
  `step.error`/`lastErrorClass`/`finishReason` twins read the row's `null`
  again instead of `?? undefined`.
- `src/report-render/test/hybrid-svg.test.ts:453` — the new `<image>` crop tuple
  cast left the tree; replaced with per-member `?? Number.NaN` reads (the
  file's own idiom — NaN fails the `toEqual` beside it). The :421 cast stays: it
  refines the baseline's own `as number[]` into the test's typed `drawn`
  declaration.
- `src/tools/bio/search-regulatory-approvals.ts:159` — restored the four
  empty-array filter gates (`hasDesignation`, `moleculeType`,
  `authorizationStatus`, `agency`); an empty array means "match nothing" on the
  wire. The date and `isOrphan` assignments stay direct: the dates are
  regex-bounded non-empty, `isOrphan` is `undefined`-only.
- `src/tools/bio/search-patents.ts` — restored the `cpcCodes` empty-array gate,
  with `assignee`/`inventor`/`countryCode` beside it; the date assignments stay
  direct (regex-bounded non-empty).
- `src/tools/bio/drug-gene-interactions.ts` — restored the `interactionTypes`
  and `sourceDbs` empty-array gates; `minSources`/`includeAttributes` stay
  direct (`undefined`-only).
- `src/tasks/data-profile-index.ts:98` — restored the `slots` `.length > 0`
  gate, with the `categoryLabel` truthiness gate beside it (vector-index
  metadata).
- `src/citations/clients/crossref.ts:44`, `doi-registry.ts:40`,
  `semantic-scholar.ts:29` — restored the `authors` empty-array gates (an empty
  list is truthy and dilutes `recordSimilarity`'s author weight), and the
  `dateParts?.[0]` year-condition twins on crossref and doi-registry.

Left direct on purpose, checked against the baseline: the `=== undefined`-only
collapses. A direct assignment already equals the baseline's value ternary
there — for example the `matchCitation` fields (the callee reads `?? ""`) and
`sourceOutcome.detail`.

Corrected 7.1 cast classification: 87 moved pre-existing casts + 1 violation
found and fixed during 7.1 (oncoprint `cellClass`) + 1 permitted
`"rendered" as const` (preview-report) + 6 target-refinements of pre-existing
casts (manhattan x3, volcano x2, gallery x1 — the removed line held the cast,
the added line refines its target) + the hybrid-svg :421 refinement of the
baseline's own `as number[]`. The second hybrid-svg tuple cast — the `<image>`
crop read at :453, new against the baseline and misrecorded as permitted above —
was found by this round and fixed. The change again adds no cast.

### Gates after correction round 1

- `bun run lint`: exit 0, zero reports.
- `bun run typecheck`: exit 0, zero errors.
- `bun test`: 6116 pass / 51 skip / 0 fail, green on the first run (51 = the
  pre-existing gallery-data gate).
- Per-module runs over the touched modules: 466 + 135 + 110 tests, 0 fail
  (three batches, including the adjacent consume-side suites: absorb,
  orientation, state data-profile, pubmed-bounding, describe-call, misc-tools).
- `bun run format:file` ran on all 22 changed files.
- Added `!`: 0. No new `as`, no `@ts-expect-error`, no lint directive.

## Correction round 2

A recheck found residual sites of the collapsed-gate class plus two shaping
issues. Each site was verified against `git show 789d7eab:harness/<path>` and
the baseline gate restored (value ternary or if-form; no new `as`, no new `!`
in src non-test, no directives).

- `src/tasks/data-profile-resolve.ts:471` — restored the `observation.note`
  truthiness gate as the if-form on the resolved slot observation. The zod
  schema accepts `""`, and the baseline dropped the key entirely.
- `src/tasks/data-profile-resolve.ts:553-567` — restored the baseline gates on
  the resolved dimension as the if-form on a named `resolvedDimension`:
  `categoryLabel` and `description` truthiness gates, the
  `reconciliations.length > 0` gate (absorb's `data-profile-absorb.ts:189`
  still gates on length, so resolve must agree for the same dimension), and
  the `treatmentReason` truthiness gate. The reconciliations mapping itself is
  unchanged (`delta` stays direct — a `!== undefined`-only collapse, left
  direct on purpose per round 1).
- `src/tasks/data-profile-index.ts:130` — restored the
  `dimension.categoryLabel` truthiness gate (dimension entry metadata).
- `src/tasks/data-profile-index.ts:153` — restored the `format` truthiness
  gate on the member entry.
- `src/tasks/data-profile-index.ts:203` — restored the `group.format`
  truthiness gate on the kind entry.
- `src/tasks/data-profile-index.ts:231-233` — restored the `dataType`,
  `format`, and `tags` truthiness gates on the file entry.
- `src/tools/research/generate-plan.ts:995` — restored the
  `outcome.questionContext` truthiness gate (value ternary).
- `src/tools/bio/search-regulatory-approvals.ts:162` — restored the
  `input.amassId` truthiness gate (value ternary): `amassId: ""` must not go
  out as a query parameter. The dates stay direct per round 1.
- `src/tools/sandbox/list-available-refs.ts` — two issues. (a) :545-557: the
  legacy metadata block lost the `rows` guard and carried a pointless
  `x ? x! : undefined` shape; restored the baseline gates (five `stringValue`
  truthiness gates and the `numberValue(item.rows) !== undefined` gate) as the
  if-form over named consts, which narrows properly and removes the baseline's
  own `!` tokens instead of keeping them. (b) :517-533: the managed-receipt
  block's direct `dataset?.x` assignments put present-`undefined` keys into an
  object that the merge at :559 spreads over the legacy metadata, clobbering
  legacy values where the baseline key was simply absent; restored absence
  with the if-form on a named `managedMetadata`. Both blocks build through a
  module-local `ReferenceInventoryMetadataBuilder` (a `-readonly` mapped view
  of `ReferenceInventoryMetadata`), because the interface's fields are
  `readonly` and the if-form must assign after construction.

Regression test pinning the class:
`src/tasks/test/data-profile-resolve.test.ts`, `dimensions` describe,
"leaves an empty note, categoryLabel, and reconciliations out of the
resolution" — feeds a dimension with `categoryLabel: ""`, `reconciliations:
[]`, and a slot observation with `note: ""`, then asserts with
`not.toHaveProperty` that all three keys are absent from the resolved output.
Bun's `toHaveProperty` counts a present-`undefined` key as present, so the
assertion pins true absence — the reason these two files take the if-form
rather than the value ternary.

### Gates after correction round 2

- `bun run lint`: exit 0, zero reports.
- `bun run typecheck`: exit 0, zero errors.
- `bun test`: 6168 tests across 358 files, 0 fail. The first run reported
  3 fail, all three from a scratch matcher probe under `tmp/pi/` that the run
  swept up; the probe was removed and the re-run was green.
- Per-module runs over the touched files: resolve suite + property + index +
  absorb 83 pass; list-available-refs + search-regulatory-approvals 57 pass;
  generate-plan 35 pass; the consume-side suites (orientation, state
  data-profile, view, reconcile-orphaned) 90 pass. 0 fail.
- `bun run format:file` ran on all 5 changed src files.
- Added `!`: 0. Added `as`: 0. No `@ts-expect-error`, no lint directive.
