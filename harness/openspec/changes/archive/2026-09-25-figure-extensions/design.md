# Design

## Context

- The change `canonical-figures` (archived as `2026-09-25-canonical-figures`) holds the figure registry, the semantic channels, the statistics, the track, the named renderers, and the gallery. Read its `design.md` first. Its non-goals name the dendrogram, the UpSet plot, the Sankey diagram, and the LocusZoom panel.
- The research notes sit in `tmp/claude/research/out/` of the working clone. `r3a-bulk.md` section 5 names the dendrograms of a clustered heatmap. `r3c-clinical.md` section 5 gives the LocusZoom design. `r5-echarts.md` sections 4, 24, and 25 give the ECharts means for the dendrogram, the Sankey diagram, and the UpSet plot. `r1-frequency.md` ranks them: dendrogram 33,350, Sankey 7,717, UpSet 5,961 open-access papers in 2020–2025.
- A chart block resolves its binding, its track, and each statistic through slots (`binding`, `track`, `statistic:N` in `src/report-model/block-walk.ts`). A new reference joins by a new slot.
- The SVG export refuses a chart past `SCATTER_CROWD_ROWS` drawn coordinates, because a vector file of many thousands of points is too large. ECharts on the page draws on a canvas. Node has no canvas without a new dependency.
- The option goes to the page as inline JSON, thus it holds no function. A function is a named page function, and the bootstrap binds it after the parse.
- The gallery data is not in the repository. `scripts/gallery-data.sh` downloads and derives it.
- The user constraint: no inflexa run and no product LLM call. A GLM model through Pi can author blocks in the blind test.

## Goals / Non-Goals

**Goals:**

- Each new figure draws the canonical design of its field from run tables.
- A dense chart exports an SVG file whose axes and text stay vectors.
- The toolbox replaces the export row, and the page keeps each export.

**Non-Goals:**

- A tree on a dot plot or on another chart type. The heatmap is the one reader of a tree.
- A LocusZoom that computes LD or the recombination rate. The run gives both as columns.
- A PDF export.

## Decisions

### E1. The tree bindings

The chart block gains `trees?: { x?: TreeBinding, y?: TreeBinding }`. A `TreeBinding` is `{ binding: ArtifactTableReference, parent: string, child: string, height: string }`. The three names are columns of the tree table.

- One row is one edge. A leaf is a child that is never a parent, and each leaf must equal one category of its axis. The root is the one parent that is never a child. A missing leaf, an extra leaf, two roots, a cycle, or a child height over its parent height refuses, and the problem names the fault.
- The leaf order is the depth-first order of the tree, with the children of a node in the order of the table. The axis takes that order. An `orderBy` on the same axis refuses, because two orders conflict.
- The slots are `tree:x` and `tree:y`. The structural tier checks the three columns against the tree table.
- The heatmap draws the tree of `x` above the matrix and above the tracks. It draws the tree of `y` at the left of the row names. The branches are elbows through a new `elbow` renderer, or a `lines` series if JSON serves. The height of the tree band is a design constant.

### E2. The `upset` preset

It reads `x` (the element) and `group` (the set), one row for each membership. A computed summary gives the size of each set and the exact intersection of each element, that is, the combination of sets that holds it.

- The intersections sort by size, then by degree, then by the set order. At most 30 draw, and the axis title states the count of the hidden ones.
- The sets sort by size, largest at the top.
- The top grid draws the intersection bars with their counts. The middle grid draws the dot matrix: a dark dot for each member set, a light gray dot for each other set, and a line that joins the member dots. The left grid draws the set-size bars.

### E3. The `sankey` preset

It reads `x` (the source node), `y` (the target node), and `value` (the flow), one row for each flow. `group` is optional. It names the category of each flow, and each flow takes the palette color of its category. The nodes then draw gray.

- The nodes keep the order of their first appearance (`layoutIterations: 0`), thus the table order is the layout.
- A node name is unique across the stages. A cycle refuses, because the Sankey series draws a directed acyclic graph.
- Each node takes a palette color by its stage order, and each flow takes the color of its source at a light opacity. The node labels sit beside the nodes, and each flow value rides the tooltip.

### E4. The `locuszoom` preset

It reads `x` (the position on one chromosome), `y` (the p-value, and the preset applies `neg_log10`), `color` (the r² with the lead variant), `label` (the variant id), `metric` (the recombination rate), and `track` (the genes: start, end, label).

- The points take the five LocusZoom bins of r²: 0 to 0.2 navy, 0.2 to 0.4 sky blue, 0.4 to 0.6 green, 0.6 to 0.8 orange, 0.8 to 1 red. A row with no r² takes gray. A legend states the bins.
- The lead variant is the row with the largest −log10 p. It draws as a purple diamond with its label.
- The recombination rate draws as a blue line on a right axis in cM/Mb, from the rows in position order.
- A line marks 5 × 10⁻⁸. The x axis reads in megabases.
- The track draws each gene as a line with its name under the plot, in lanes that never overlap, as the lollipop draws its domains.

### E5. The hybrid export

A chart past the SVG point bound gets its SVG files from the page, on a click:

1. The page draws the option with the SVG renderer, offscreen, at the export size. Each point layer keeps only its rows that carry a label. It also gets two anchors with no symbol, at the least and the greatest value of each dimension. Thus each axis keeps the extent of the full rows. The axes, the text, the legend, and the guides stay.
2. The page draws the dense series alone, with the same axes and each other element hidden, on an offscreen canvas at 300 DPI.
3. A pure function puts the canvas image into the SVG as one `<image>` element at the rectangle of the grid, under the vector marks.

The server stages no SVG for such a chart, as today. The pure function of step 3 has a unit test, and a headless capture proves the click.

### E6. The toolbox (#595)

The export row retires. Each page chart carries a toolbox at the top right:

- `myExport`: a download icon. A click opens a small menu with the two SVG entries and the three PNG entries. An SVG entry links the staged file, or it builds the hybrid file of E5. The menu closes with Escape and on an outside click.
- The runtime draws the icon on the canvas and binds a mouse click alone. Thus the title line of the card carries a download button that the keyboard reaches, and the button opens the same menu.
- `dataView` with `readOnly: true`: the plotted rows as a plain table, through a named page function.
- `dataZoom` and `restore`: on a dense cartesian chart only (scatter, embedding, volcano, ma, manhattan, qq, locuszoom).
- No `magicType`, because a reader must not change the form that the author chose.

Each `onclick` and each content function is a named page function that the bootstrap binds after the parse. The toolbox stays out of print and out of each export.

### E7. The gallery

The gallery gains these uses:

- a heatmap of the top genes with both trees.
- the sample distances with one tree on both axes.
- an UpSet plot of the co-mutated genes of TCGA LAML.
- a Sankey diagram of the LAML patients.
- a LocusZoom panel of the FTO locus of the BMI study.

`scripts/gallery-data.sh` downloads and derives each new table, and the manifest states its source and its license.

## Risks / Trade-offs

- **The hybrid file is not a pure vector file.** A journal accepts a raster point layer at 300 DPI inside a vector file, and Seurat and scanpy give the same form. The server stays free of a canvas dependency.
- **The LD source.** The r² comes from a public reference panel through the pipeline, thus its population must match the study. The manifest states the panel.

## Migration Plan

No migration. Each new field is optional.

## Open Questions

None.
