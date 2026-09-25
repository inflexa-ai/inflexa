# Tasks

Each task names its proof. A proof is a test, a command, or a read of an output. No task runs inflexa or calls a product LLM.

## 1. The foundation (WP1, first)

- [x] 1.1 Add the presets `pca`, `embedding`, `dotplot`, `forest`, `roc`, `qq`, `gsea`, `oncoprint`, and `lollipop` to the chart type enum. Add the channels `shape`, `p`, `censor`, `risk`, `hit`, `metric`, and `tracks` to the quick-path encoding (D2). Write the teaching text of each member, with the presets that read it. Proof: parse tests for each new member and each new type.
- [x] 1.2 Add `statistics` (1 to 4 entries) and `track` to the chart block (D3, D4). Proof: parse tests, and a refusal of five statistics.
- [x] 1.3 Add each new channel, each track column, and each statistic reference to `src/report-model/block-walk.ts`, with a slot name for each reference. Proof: block-walk and structural-validation tests refuse an absent channel column and an absent track column.
- [x] 1.4 Resolve the binding, the track, and each statistic of a chart block in the resolution pass, the preview, and the record gate. Bridge them into the render value (D3, D4). Proof: resolution tests with the fixture resolver, and a preview test that renders a chart with a statistic and a track.
- [x] 1.5 Mark each statistic reference and the track reference in the ledger. Each one gets a marker on the chart title line and an entry in the appendix. Proof: a render test.
- [x] 1.6 Make `src/report-render/figures/` with `index.ts` (the registry) and `common.ts` (the helpers of D1 and D6). Dispatch from `deriveRaw`. A preset with no module keeps its path. Proof: a chart test shows that a registered preset takes its module and an unregistered preset keeps its composition.
- [x] 1.7 Register each renderer with `echarts.registerCustomSeries` on the page and in the export. Retire the string swap of the bootstrap (D5). Proof: the shared twin vector still passes, a page test shows the registration, and the export renders an interval through the registry.
- [x] 1.8 Apply the theme rules of D6 to the shared axis and legend path of `chart.ts` and `design.ts`. Move the export text to 7 pt at the column width. Proof: chart and design tests for the rotated y title, the hidden category title, and the guide label place. Also for the scale ends, the palette past eight categories, and the legend icons.
- [x] 1.9 Refuse each channel, the statistics, and the track on a preset that does not read them. Proof: chart tests.
- [x] 1.10 Write the delta specs of `report-block-model` and `report-value-resolution`, and the theme requirements of `report-render`.

## 2. The clinical figures (WP2)

- [x] 2.1 `figures/km.ts` (D7). Proof: chart tests on the lung table: the step lines, the step band, the censor ticks, the risk table at the axis ticks, the median lines, and the statistic text.
- [x] 2.2 `figures/forest.ts` (D7). Proof: chart tests on the Cox table: the log axis range, the line at 1, the squares, the table order, and the two text columns.
- [x] 2.3 `figures/roc.ts` (D7). Proof: chart tests on the ROC table: the steps, the diagonal, the equal axes, and one AUC for each curve.
- [x] 2.4 Write the `report-render` requirements of the three figures.

## 3. The dense scatter figures (WP3)

- [x] 3.1 The `volcano` upgrade (D7). Proof: chart tests on the pasilla table: the null layer first, the counts in the legend, ten labels with the overlap layout, the symmetric axis, and the payload path past the bound.
- [x] 3.2 The `ma` upgrade (D7). Proof: chart tests: the log x axis, the blue significant points, the line at zero, and the symmetric y axis.
- [x] 3.3 The `manhattan` upgrade (D7). Proof: chart tests on the GWAS table: the alternating colors, the chromosome names, the two lines, and the lead labels.
- [x] 3.4 `figures/qq.ts` (D7). Proof: chart tests: the band, the identity line, the range of each axis, and the λ text.
- [x] 3.5 Write the `report-render` requirements of the four figures.

## 4. The single-cell and bulk figures (WP4)

- [x] 4.1 `figures/pca.ts` (D7). Proof: chart tests: the equal units, the shape channel, and the labels of a small table.
- [x] 4.2 `figures/embedding.ts` (D7). Proof: chart tests on PBMC 3k and Kang: the hidden axes, the corner key, the point size rule, and the labels at the group medians. Also the gray ground and the clip of a continuous color, and the facet.
- [x] 4.3 `figures/dotplot.ts` (D7). Proof: chart tests on the marker table and on the enrichment table: the size legend, the formatted color scale, and the orders.
- [x] 4.4 The `heatmap` tracks and rules (D7). Proof: chart tests on the pasilla heatmap: the strips, the track legends, the diverging z-score, the cell gap, and the hidden labels past 40 categories.
- [x] 4.5 Write the `report-render` requirements of the four figures.

## 5. The mutation figures and the distribution rules (WP5)

- [x] 5.1 `figures/oncoprint.ts` and the `cell-glyph` renderer (D5, D7). Proof: chart tests on the LAML table: the glyph cells, the class colors, the top count bar, the right share bar with its percent text, and the unaltered samples.
- [x] 5.2 `figures/lollipop.ts` and the `stem` renderer (D5, D7). Proof: chart tests on DNMT3A: the stems, the heads, the domain band from the track, the axis length, and the three labels.
- [x] 5.3 The points of the `box` and the `violin`, and the facet of the two stacked bars (D7). Proof: chart tests.
- [x] 5.4 Write the `report-render` requirements of these figures.

## 6. The enrichment figure (WP6)

- [x] 6.1 `figures/gsea.ts` (D7). Proof: chart tests on the running-score table: the three panels, the shared x axis, the hit ticks, the metric area, and the statistic text.
- [x] 6.2 Write the `report-render` requirement of the figure.

## 7. The gallery, the fixture, and the prompt (WP7)

- [x] 7.1 Copy the derived tables into `src/report-render/gallery/data/` under the 4 MB bound, and write `manifest.json` (D8). Proof: a test reads the manifest and each file, and the total size.
- [x] 7.2 Write `gallery.ts`, `scripts/render-gallery.ts`, and the `design:gallery` script (D8). Proof: the script prints the path of a page that holds each gallery chart.
- [x] 7.3 Write `gallery.test.ts` (D8). Proof: the test passes.
- [x] 7.4 Remove the synthetic chart forms from `fixture.ts`, and move each test that reads them onto the gallery. Proof: the fixture and render tests pass.
- [x] 7.5 Update the prompt (D9). Proof: the prompt tests.
- [x] 7.6 Write the `report-design-system` and `report-session-agent` requirements.

## 8. The proof of the whole

- [x] 8.1 Render the gallery, capture each chart in a headless browser, and compare each capture with the canonical design of its research note. Record each fault and repair it.
- [x] 8.2 Blind authoring: a GLM model through Pi receives only the block schema, the prompt, the column list of each table, and the intent of each chart. It writes each gallery block. Each block must parse, pass the structural tier, and render. Repair each schema text that misled it.
- [x] 8.3 Run `tsc`, the lint, and the full test suite one time. Validate the specs with `openspec validate`.
