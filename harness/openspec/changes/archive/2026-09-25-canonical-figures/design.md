# Design

## Context

See `proposal.md` for the motivation. These facts shape the approach:

- The grammar is `src/contracts/report-blocks.ts`. The derivation is `src/report-render/chart.ts` (about 3,700 lines), with the preset expansion in `chart-presets.ts`, the renderers in `chart-renderers.ts`, and the export in `chart-export.ts`. The theme is in `design.ts`, and the page bootstrap is `CHART_BOOTSTRAP` in `page.ts`.
- A preset expands into a composition today (`expandPreset`). A composition draws series of one grid over one table. A canonical figure often needs more: a table under the plot, a text column beside it, stacked panels, a glyph in a cell, or a track from a second table.
- The resolution pass gives one `ResolvedValue` for each block (`resolveDocumentReferences`, `collectResolutions` in `src/tools/report-session/preview-report.ts`, and `bridgeValues` in `src/report-render/value-bridge.ts`). The record gate walks the same pass.
- ECharts 6.1.0 exports `registerCustomSeries(type, renderItem)`. A custom series then names its renderer as a string, and it takes JSON parameters in `itemPayload`. The page and the SSR render both hold the registry.
- ECharts 6 has the `jitter` of an axis, `labelLayout` with `hideOverlap` and `moveOverlap`, the `matrix` coordinate system, and the `step` of a line. A `graphic` element sits at a pixel or a percent place, and it reads no data coordinate.
- The option goes to the page as inline JSON, thus it holds no function. The agent authors no raw option (#372).
- The user constraint: no inflexa run and no product LLM call. The proofs are unit tests, render tests, the gallery script, and a headless capture of the gallery page.
- The research notes sit in `tmp/claude/research/out/` of the working clone. `r3a-bulk.md`, `r3b-singlecell.md`, and `r3c-clinical.md` give the canonical design of each plot. `r2-rules.md` gives the rules of a publication figure. `r5-echarts.md` gives the ECharts means for each plot. The implementor reads the note of its plots before it writes code.
- figures4papers (CC BY-NC 4.0) gives principles only.

## Goals / Non-Goals

**Goals:**

- Each preset draws the canonical design of its plot from one run table, and a reader of the field recognizes it at once.
- Each figure obeys the rulebook: the text sizes, the line widths, the axes, the colors, and the labels.
- A statistic on a figure is grounded, and a track table resolves as a binding does.
- The derivation stays a pure, deterministic function of the document, the rows, and the resolved statistics.
- The gallery of real data is the visual proof and the regression set.

**Non-Goals:**

- A dendrogram. The run gives an order, and the heatmap reads it. A linkage table and its tree are a later change.
- These plots are later presets:
  - a LocusZoom panel and a trajectory graph.
  - an UpSet plot, a Venn diagram, and a Sankey diagram.
  - a sequence logo, a swimmer plot, a calibration plot, and a waterfall plot.
- The toolbox of the chart card. The user keeps it for a later change.
- An aggregate that the run can give. A figure computes only a summary that its canonical design draws from the rows: a count of classified rows, a group median position, a number at risk at an axis tick, and a share of samples. The spec names each one.

## Decisions

### D1. The figure registry

A new directory `src/report-render/figures/` holds one module for each figure preset. Each module exports one derivation with the signature `(block, rows, context) => Result<EchartOption, RenderProblem>`. The context carries the resolved statistics, the resolved track, the column labels and meanings, and the text-size profile. `figures/index.ts` maps each preset to its module. `deriveRaw` in `chart.ts` asks the registry first. A base type with no module keeps its fixed rule, and a preset with no module refuses. The `volcano`, `ma`, `manhattan`, and `km` presets keep no expansion beside their modules, because each module draws elements that no composition holds.

A preset that draws one point for each row of a dense table keeps the payload path. The module then builds its primary series through the composition machinery of `chart.ts` (`deriveComposition` and the source collector), and it adds its own members around the result.

The dense presets are `volcano`, `ma`, `manhattan`, `qq`, and `embedding`.

A shared module `figures/common.ts` holds the helpers that each figure reads:

- the axis builders of the theme, with the rotated y title and the category axis with no raw name.
- the statistics text, the formatted color scale, and the size legend.
- the categorical palette and the guide-line style.

Each figure reads these helpers and never writes its own axis style.

Alternative: grow the composition until it draws each figure. Rejected, because a table under a plot, a text column, and a glyph cell are no series of one grid. The composition would grow a member for each preset.

### D2. The semantic channels

The quick-path encoding gains seven members. Each member is optional, and each preset refuses a member that it does not read.

| Channel | Type | Read by | Meaning |
| --- | --- | --- | --- |
| `shape` | channel | `pca`, `scatter` | A second category that sets the symbol of each point. |
| `p` | channel | `ma`, `forest` | The p column that classifies a point, or that fills the p column of a forest. |
| `censor` | channel | `km` | The count of censored subjects at the time of the row. |
| `risk` | channel | `km` | The number at risk at the time of the row. |
| `hit` | channel | `gsea` | 1 where the ranked gene is a member of the set, else 0. |
| `metric` | channel | `gsea` | The ranking metric at the rank of the row. |
| `tracks` | array of column names, 1 to 4 | `heatmap`, `oncoprint` | The columns that draw as annotation strips along the x axis. Each value must be constant for one x category. |

`chartColumns` in `src/report-model/block-walk.ts` adds each new channel, thus the structural tier refuses a column that the table does not hold.

### D3. The statistics

The chart block gains `statistics?: Array<{ label: string, value: ArtifactValueReference }>`, with 1 to 4 entries. The label is a short name, for example `Log-rank p` or `AUC`. The value binds one cell.

- `walkBlocks` collects each statistic reference beside the binding, with the block id and a slot name (`statistic:0` to `statistic:3`).
- The resolution pass resolves each statistic. A failure names the block and the slot, as a binding failure names the block.
- The render value of a chart gains `statistics?: Array<{ label: string, value: string | number }>`, in the order of the block.
- A figure prints each statistic as one line of text inside the plot, at the place that its field uses. The number helper formats the value, and the kind follows the column name of the locator, as a table cell does. A p-value zero prints the below-resolution form.
- The ledger marks each statistic reference. The chart title line carries a marker for each reference, and the appendix lists each one.

### D4. The track

The chart block gains `track?: { binding: ArtifactTableReference, start: string, end: string, label: string, length?: string }`. The four names are columns of the track table. The track resolves as the binding does, and the structural tier refuses an absent column. The render value of a chart gains `track?: { rows, columns }`. The `lollipop` is the one preset that reads a track, and each other preset refuses it.

### D5. The native custom series

`chart-renderers.ts` exports one registration function for each twin. The page bootstrap calls `echarts.registerCustomSeries(name, fn)` for each renderer before the first chart initializes. The export calls the same registration on the server module before it draws. A derived custom series carries `renderItem: "<name>"` and its parameters in `itemPayload`. The string swap of the bootstrap retires, and the shared test vector of the twins stays. The renderers of this change are `interval`, `outline`, `cell-glyph` (an oncoprint cell), and `stem` (a lollipop stem).

### D6. The rules of the theme

These rules apply to each chart, and a figure can add its own:

- The y title turns 90 degrees, and it sits in the middle beside the axis. The x title sits in the middle under the axis.
- A category axis shows a title only when the block declares a label or an axes title. A value axis always shows a title.
- A guide line is thin, gray, and dashed. Its label sits inside the plot at the far end of the line, and it never covers a tick label.
- A continuous color scale shows its title and its two end values as text that the number helper formats. It shows no drag control.
- The categorical palette is Okabe-Ito for eight categories or fewer. For more, it is a fixed list of 24 distinct colors, and the order is stable.
- A legend icon matches the form of its series: a line for a line and a step, a filled square for a bar and an area, and a circle for a point.
- The text sizes, the line widths, and the export sizes of the first pass stay. The export text size moves to 7 pt at the column width (9.33 px), the upper bound of the Nature guide.
- A figure never skips a category label. A facet label that does not fit its band turns 45 degrees, then 90 degrees. An axis title never covers its labels: an option whose grid holds its labels states the runtime move of each title.
- A figure of many rows states the height of its chart body. The card takes that height, and each column export grows its height in the same ratio, up to 170 mm. A facet grows its body one row of panels at a time by the same rule.
- A figure of one unit draws a square block. The page body narrows to the block and centers it, and one media rule for each export size centers the block in the export.
- The export scales each text to its text size, the children of a graphic group included. The panels of a facet end over the legend lines that the export width gives.
- A number in the scientific form prints as a power of ten with superscript digits inside the chart, for example `1.3 × 10⁻³`. A table cell and a metric card keep the short form `1.3e-3` of the number helper. `typographicExponent` in `number-format.ts` rewrites the shown form, thus a below-resolution bound keeps its digits.

### D7. The canonical figures

Each entry states the channels, the canonical elements, and each computed summary. `r3a-bulk.md`, `r3b-singlecell.md`, and `r3c-clinical.md` hold the sources.

- **`volcano`** (x = effect, y = p, `label`, `thresholds`): the null points draw first, in gray and smaller. The two signal sides draw in the down color and the up color. The legend names each side with its count (a computed count of classified rows). The ten most significant signal points carry the `label` text. The derivation places each name with a leader line, clear of each other name and of each point, at the plot of the single-column export. The chart runtime moves no label that sits on its point, thus `labelLayout` cannot do this work. The x axis is symmetric around zero. A row with no p drops. A stored p of 0 draws as an upward triangle at the top of the plotted range, on the side of its effect.
- **`ma`** (x = mean, y = effect, `p`, `label`, `thresholds.significance`): the x axis is log10. The null points are gray, and the significant points are blue, as the DESeq2 default. A line sits at zero. The y axis is symmetric around zero.
- **`pca`** (x, y, `group`, `shape`, `label`): one unit on x equals one unit on y. The group sets the color, and the shape channel sets the symbol. A table of 20 rows or fewer carries the `label` text on each point. The axis titles read the declared labels, where the run states the variance.
- **`embedding`** (x, y, one of `group` or `color`, and the optional `facet`): the axes hide, and a small corner key names the two dimensions. One unit on x equals one unit on y. The point size follows the cell count (the scanpy rule 120000 / n, bounded between 1 and 6 px), with a light opacity. With `group`, each category name draws on the data at the median position of its points (a computed summary), and no legend draws. With `color`, a zero value draws in a light gray ground, and the high values draw on top. The scale clips at the 99th percentile (a computed summary).
- **`dotplot`** (y = category, x = category or value, `size`, `color`): a size legend draws three reference circles with their values. The color scale is sequential, with formatted ends. The category order follows the `orderBy` of each channel. A long term wraps into two lines at most, and it ends with an ellipsis past two lines. Many terms grow the body.
- **`heatmap`** (x, y, `value`, `tracks`): each track draws as one strip of category colors above the matrix, with a legend for each track. A z-score or another zero-crossing value takes the diverging ramp. The cells have a thin white gap, and the axis lines hide. When the x axis holds more than 40 categories, the labels hide and the axis title states the count. A matrix of many rows grows the body to 16 px for each row, thus each row name prints. The track legends take a band of their own over the strips.
- **`km`** (x = time, y = survival, `group`, `low`, `high`, `censor`, `risk`): each group draws a step line from 1 at time 0. The band between `low` and `high` draws as a step band. Each row with a censor count above zero carries a small vertical tick on its curve. A number-at-risk table draws under the plot, with one row for each group, at the ticks of the x axis (a computed lookup: the risk of the first row at or after the tick, and 0 past the last row). The median line draws at 0.5 to each curve that crosses it (a computed lookup). The statistics print at the top right. The y axis is 0 to 1.
- **`forest`** (y = term, x = estimate, `low`, `high`, `p`, `size`): the rows read top-down in table order unless `orderBy` sorts them. The x axis is log10 when each value is positive, and its range ends at the nice ratio just past the data. A solid gray line sits at 1. Each estimate is a square, and `size` sets its area. A text column at the right prints the estimate with its interval at one count of decimals, for example `0.53 (0.38–0.75)`. The count is 2 for values of 0.1 or more, and it gives two significant digits to a smaller value. A second column prints `p` when the channel is present. A long term breaks onto two lines, thus the figure fits the single column.
- **`roc`** (x = false positive rate, y = true positive rate, `group`): each group draws an empirical step curve. A dashed diagonal marks chance. One unit on x equals one unit on y, and both axes span 0 to 1. The legend sits in a band under the square. The statistics print at the bottom right, one AUC for each curve, as the label of a point at (1, 0).
- **`qq`** (x = expected, y = observed, `low`, `high`): the points draw small. The band between `low` and `high` draws in light gray under them. An identity line runs from 0 to the largest expected value. Each axis has its own range, as in qqman: x ends at the largest expected value, and y ends at the largest observed value. A strong GWAS signal reaches far past the expected range, thus one shared range would push the points into a thin strip at the left. The statistics print at the top left, for example λ.
- **`manhattan`** (x = cumulative position, y = p, `group` = chromosome, `label`): the chromosomes read in genome order, whatever the order of the rows, and they alternate between two colors. Each chromosome name sits under the middle of its points (a computed summary). Two lines mark 5e-8 and 1e-5. The label of the 5e-8 line sits over its right end, and no lead name covers it. The lead variants carry their names with leader lines, placed as the volcano names are, at the plot of the double-column export.
- **`gsea`** (x = rank, y = running score, `group` = set, `hit`, `metric`): three stacked panels share the x axis. The top panel draws the running score of each set and a line at zero. The middle panel draws a tick at each hit of each set. The bottom panel draws the ranked metric as an area. The statistics print in the top panel.
- **`oncoprint`** (x = sample, y = gene, `value` = alteration class, `tracks`): each cell draws a gray ground and one glyph for its class through the `cell-glyph` renderer. A fixed map gives each common class of the MAF standard its color, and an unknown class takes the palette. A bar over the matrix draws the alteration count of each sample (a computed count). A bar at the right draws the share of altered samples for each gene, with its percent text (a computed share over the samples of the table). A row with an empty class names a sample with no alteration. A figure of many genes grows the body to 16 px for each gene, thus each gene name and each percent text prints.
- **`lollipop`** (x = amino-acid position, y = count, `group` = class, `label`, `track`): each mutation draws a stem from zero and a head, through the `stem` renderer. The track draws each domain as a labeled box on a band under the axis. The x axis spans 0 to the `length` column of the track, or to the largest end and position. The three largest counts carry the `label` text.
- **`box`** and **`violin`**: each point draws over the shape when each slot holds 200 values or fewer. One slot past 200 values removes the points of each slot, thus one chart shows the points on each slot or on none. A chart with no group spreads its points with the axis jitter. A grouped chart places each point inside the slot of its group, on a hidden value axis over the category bands. A slot with no shape draws its median as a short line, thus a chart of few replicates is never empty.
- **`stacked-bar`** and **`normalized-bar`**: the facet becomes legal, with the panel rules of the first pass.

### D8. The gallery

- `src/report-render/gallery/data/<field>/<table>.csv` holds each derived table. The total stays under 4 MB, and a dense table thins by the rule of its field, as the manifest states.
- `src/report-render/gallery/manifest.json` names the dataset, the citation, the license with its URL and a quote, the source URLs, and the derivation of each table.
- `src/report-render/gallery/gallery.ts` exports the gallery document and a loader that parses each table into the render values. The document holds one section for each field and one chart for each preset use.
- `scripts/render-gallery.ts` renders the gallery into a directory under the system temp directory and prints the path. `package.json` gains `design:gallery`.
- `src/report-render/gallery/gallery.test.ts` renders the whole gallery with no problem, two times with the same bytes. It asserts the canonical elements of each preset in the option.
- The synthetic chart forms leave `fixture.ts`. The fixture keeps one chart for the block-kind coverage.

### D9. The prompt

The block schema carries the teaching text of each preset, channel, statistic, and track. The prompt adds one paragraph: a plot of a field takes its preset, a statistic of the figure binds as a statistic, and a second table binds as a track. The figure-last paragraph names the presets through the schema, not through a list of its own.

## Risks / Trade-offs

- **Scope.** The change is large. The registry keeps each figure in its own module, thus the figures build in parallel and review apart.
- **Computed summaries.** Each figure computes a small summary from the rows. The spec names each one, and each one reads the rows of the one bound table, thus it is deterministic and it cites its source.
- **Channel count.** The encoding grows to seventeen members. Each preset refuses what it does not read, and the schema text of each member names the presets that read it.
- **Dense figures.** An embedding past the export bound gets no SVG, as in the first pass.

## Migration Plan

No migration. Each new field is optional. A stored preset chart takes the canonical design at its next preview.

## Open Questions

None. The user decided the direction and the scope in the conversation.
