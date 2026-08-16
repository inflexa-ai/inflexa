# Proposal: orient-the-bar-horizontal

## Why

The enrichment section of the session still shows a matplotlib PNG. The chart-first rule could not fire. The GSEA NES chart needs the category on the y axis, because the set names are long. But the grammar has no orientation on a bar. With the orientation, the figure becomes a chart block over the GSEA summary table, and the design system styles it.

## What Changes

- The bar gains an optional orientation: `vertical`, the default, and `horizontal`. The quick path carries it beside the chart type, and the composition carries it on the bar series form.
- An orientation on a quick-path type that is not a bar refuses as a render problem, because a stated fault beats a silent ignore.
- The encoding channels keep their data meaning: `x` names the category column, and `y` names the value column. The horizontal orientation renders the category axis on y and the value axis on x.
- An annotation names a rendered axis, exactly as today. Thus a zero line on a horizontal value axis is an `x` reference line.
- The axis titles, the declared labels, and the number formatting follow the axes wherever they render.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-block-model`: the chart grammar admits the bar orientation on the quick path and on the bar series form.
- `report-render`: the derivation renders a horizontal bar, and the text rules follow the axes.

## Impact

- Affected code: `src/contracts/report-blocks.ts`, `src/report-render/chart.ts`, and their tests.
- A bar with no orientation stays byte-identical, thus every stored document renders as before.
