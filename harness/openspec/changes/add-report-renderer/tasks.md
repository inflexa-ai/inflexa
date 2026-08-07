## 1. The scaffolding and the escape layer

- [ ] 1.1 Make `src/report-render/` with the base types: the `RenderValue` closed union, the `RenderProblem` type, and the escape helper that wraps every interpolation.
- [ ] 1.2 Make the page constants: the CDN pins with their integrity hashes (copied from `templates/report-html/base.html.j2`), the inline style rules adapted from `theme.css`, and the ECharts theme as a TypeScript constant. The renderer never reads `templates/report-html` at run time.
- [ ] 1.3 Write the tests of the escape helper: a script tag, a quote in an attribute slot, and an ampersand each stay text.

## 2. The block renderers

- [ ] 2.1 Make the prose renderers: the text block, the claim block with evidence markers, and the section heading by depth with the navigation list from the top-level sections.
- [ ] 2.2 Make the value renderers: the metric stat card, the table with every resolved row, and the figure with its source and caption. Add the citation entry, and the reference list of the page.
- [ ] 2.3 Make the chart renderer: derive the option object from the chart type, the encoding, and the rows, for each of the seven chart types. Pass the option through `normalizeEchartSpec`, and inline it as JSON in a container whose id derives from the block id.
- [ ] 2.4 Write the tests of the rendered forms: the heading depth, the labeled metric, the three-row table, the figure source, the bar-chart axes, the normalized option, and the shared-reference dedupe.

## 3. The render function

- [ ] 3.1 Make `renderReportPage(document, values)`: the document walk, the value-map validation with collected `RenderProblem` values, and the `Result` channel. A claim takes no value entry.
- [ ] 3.2 Make the page assembly: the skeleton, the navigation, the reference list, and the deterministic serialization rules (no clock, no random value, no locale formatting, `String(value)` for a scalar).
- [ ] 3.3 Write the tests of the function: the byte-identical double render, the missing-value problem, the wrong-shape problem, the collected problems, the in-memory-only render, and the no-local-asset scan of the output.

## 4. The gates

- [ ] 4.1 Run `bun run format:file` on each changed source file.
- [ ] 4.2 Run `tsc -p tsconfig.json`, and repair each finding.
- [ ] 4.3 Run the lint on `src/report-render/`, and repair each finding.
- [ ] 4.4 Run the tests of `src/report-render/` only. Do not run the full suite.
