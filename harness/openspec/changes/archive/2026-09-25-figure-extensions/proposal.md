# Proposal

## Why

The change `canonical-figures` gave the report the canonical figures of each field, and it left four plots and two faults for a later change. The user asked for all of them in the same pull request as #578:

- A clustered heatmap draws no dendrogram. The research names the dendrogram on about half of all heatmaps.
- The report has no UpSet plot, no Sankey diagram, and no regional association plot (LocusZoom).
- A dense chart, for example a Manhattan plot of 25,000 variants, gets no SVG file. The point bound of the export stops the file, because a vector file of many thousands of points is too large.
- The export row of five buttons under each chart takes space, and it reads as a form. Issue #595 asks for an ECharts toolbox in its place.

## What Changes

- **Dendrograms.** A chart block can bind one tree table for each category axis of a heatmap. A tree table is an edge list with a height for each edge. The heatmap draws each tree beside its axis, and the axis takes the leaf order of the tree.
- **The `upset` preset.** It reads a membership table (one row for each element in each set). It draws the intersection bars, the dot matrix with the joining lines, and the set-size bars. The intersection counts are a computed summary.
- **The `sankey` preset.** It reads a flow table (source, target, and value). It draws the nodes and the flows in the order of the table.
- **The `locuszoom` preset.** It reads the association table of one region: the position, the p-value, the linkage disequilibrium with the lead variant, and the recombination rate. It draws the points colored by the LD bins and the lead variant as a diamond. It also draws the recombination rate on a second axis, and the genes of the region from the track table.
- **The hybrid export.** A chart past the point bound of the SVG export gets an SVG file that the page builds on a click. The axes, the text, and the legend stay vectors, and the point layer is one embedded image at 300 DPI. Seurat and scanpy use this form for large embeddings.
- **The names of the volcano and the Manhattan plot.** Each render places the point names in the frame of its own size: the page and each export size. Thus a file of the single column prints fewer names, and no two names print on top of each other. On a page narrower than its frame, the chart runtime hides a name that overlaps another name.
- **The toolbox (#595).** The export row retires. Each page chart carries a toolbox at the top right: one download control with a menu of the exports, a read-only data view, and the zoom and restore controls on a dense cartesian chart.
- **The gallery** gains one use of each new figure, from public data that the gallery script downloads. The data stays out of the repository.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-block-model`: the three presets and the tree bindings.
- `report-render`: the dendrogram, the three figures, the hybrid export, the toolbox, and the names of the volcano and the Manhattan plot.
- `report-value-resolution`: a chart block resolves its tree tables.
- `report-design-system`: the toolbox of the chart card and the gallery uses.

## Impact

- Code: `src/contracts/report-blocks.ts`, `src/report-model/`, `src/report-render/` (`figures/`, `chart-renderers.ts`, `page.ts`, `views/chart-view.tsx`, `design.ts`), and `src/tools/report-session/`.
- Data: none in the repository. `scripts/gallery-data.sh` gains the new inputs.
- Dependencies: none. The hybrid export uses the canvas and the SVG renderer of ECharts on the page.
- No inflexa run and no product LLM call proves this change.
