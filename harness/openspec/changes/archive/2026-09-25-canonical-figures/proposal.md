# Proposal

## Why

The first pass of #578 gave the chart grammar more channels, one publication theme, and an export. The design fixture of that pass used synthetic rows, and the user did not accept the result. A gallery of real public data shows why. Each plot of a field has a canonical design, and our charts draw none of them in full:

- The Kaplan-Meier curve has no censor marks, no number-at-risk table, no median line, and no log-rank p. Its band is smooth, not stepped.
- The forest plot has no estimate column, and its log axis spans two decades of empty space.
- The UMAP draws large opaque points on numeric axes, with a legend in place of labels on the clusters.
- The oncoprint renders as an empty grid, because a heatmap cell takes no category.
- The MA plot has a linear mean axis, and the volcano has no gene labels.
- The lollipop has no protein track, and a composition bar cannot split by condition.

The research of this change (the notes under `tmp/claude/research/` of the working clone) fixes the target. A measure of the open-access literature ranks the chart types that papers use. The field documents (DESeq2, scanpy, Seurat, survminer, KMunicate, qqman, maftools, ComplexHeatmap, enrichplot) give the canonical design of each. The journal guides and the teaching sources (Nature, Cell, Science, PLOS, Wilke, Rougier and co-authors, Okabe and Ito) give the rules of a publication figure.

## What Changes

- **Canonical figures.** A figure preset draws the canonical design of one plot of a field from one run table. The new presets are `pca`, `embedding`, `dotplot`, `forest`, `roc`, `qq`, `gsea`, `oncoprint`, and `lollipop`. The presets `volcano`, `ma`, `manhattan`, and `km` gain the canonical elements that they lack. The `heatmap` gains annotation tracks, the `box` and the `violin` gain their points, and the two stacked bars gain the facet.
- **Semantic channels.** The encoding gains the channels that a preset reads: `shape`, `p`, `censor`, `risk`, `hit`, `metric`, and `tracks`. Each channel names content, and a preset that reads none of them refuses it.
- **Grounded statistics.** A chart block can carry up to four statistics, for example a log-rank p, a genomic inflation λ, or an AUC. Each statistic binds one cell of a pinned artifact, and the figure prints it with the number helper. Each one joins the reference ladder.
- **A second table.** A chart block can bind one track table, for example the protein domains of a lollipop. It resolves as the primary binding does.
- **The native custom series.** The page and the export register each named renderer with `echarts.registerCustomSeries`. The derived option names the renderer as a string, as ECharts 6 documents. The string swap of the page bootstrap retires.
- **The rules of a publication figure.** The theme and the recipes obey the rulebook of the research:
  - a rotated y title beside its axis.
  - no raw column name on a category axis.
  - a guide label that never covers a tick.
  - a color scale with formatted ends.
  - a palette for more than eight categories.
  - direct labels where the field puts them.
- **A real-data gallery.** Public datasets give the plot tables of each field: pasilla, PBMC 3k, the Kang 2018 IFN-β data, the NCCTG lung data, a GWAS Catalog summary file, and the TCGA LAML mutations. The derived tables, their licenses, and a gallery document enter the repository. A script renders the gallery, and a test renders each gallery chart. The synthetic chart forms leave the design fixture.
- **The prompt** names the figure presets through the block schema, and the statistics and the track through the same schema.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-block-model`: the presets, the semantic channels, the statistics, and the track.
- `report-render`: the figure derivations, the native custom series, the statistics text, and the track draw.
- `report-value-resolution`: a chart block resolves its binding, its track, and each statistic.
- `report-design-system`: the figure rules of the theme and the real-data gallery.
- `report-session-agent`: the prompt teaches the presets, the statistics, and the track.

## Impact

- Code: `src/contracts/report-blocks.ts`, `src/report-model/`, `src/report-render/` (a new `figures/` directory with one module for each preset), `src/tools/report-session/preview-report.ts` and `record-version.ts`, and `src/prompts/report-session.ts`.
- Data: the gallery tables enter `src/report-render/gallery/`, under the bound of their licenses, with a manifest of the source and the license of each table.
- Dependencies: none.
- Stored drafts: each new field is optional, thus a stored draft still validates. A stored preset chart takes the canonical design at its next preview.
- No inflexa run and no product LLM call proves this change. The proofs are unit tests, render tests, the gallery script, and a headless capture of the gallery page.
