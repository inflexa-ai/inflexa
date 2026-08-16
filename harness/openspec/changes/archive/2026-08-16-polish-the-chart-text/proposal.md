# Proposal: polish-the-chart-text

## Why

The volcano chart of the session prints machine text. The y axis reads `neg_log10(pvalue)`, the legend reads `up_in_nonresponders`, and the null category shouts in full green. The value labels of the vertical guide lines print at the top of the plot, in the band of the y-axis title.

## What Changes

- A preset fills its own semantic axis titles, because it knows its quantities. A volcano reads "log2 fold change" and "−log10(p)", and a manhattan reads "−log10(p)" on its y axis. The precedence: an agent axes title, then a declared column label, then the preset title, then the raw or derived name.
- The category value `ns` on a preset chart takes the muted role of the palette. The significant categories carry the color, and the null category recedes.
- The value labels of a vertical reference line move to the axis end, out of the title band. A horizontal line keeps its label at the right edge.
- A category series name prettifies at derivation: underscores become spaces. The tooltip reads the same name, and the raw value stays in the data. No hover carries the raw name, because a legend formatter would be a function and the option rides as inline JSON.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-render`: the chart text rules — the preset titles, the muted null category, the guide-label position, and the legend prettify.

## Impact

- Affected code: `src/report-render/chart-presets.ts`, `src/report-render/chart.ts`, `src/report-render/design.ts` for the muted chart color, and their tests.
- The derivation stays deterministic, and a chart with no preset and no category changes nothing.
