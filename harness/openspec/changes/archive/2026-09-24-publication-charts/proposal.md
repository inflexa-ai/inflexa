# Proposal

## Why

The Report Builder puts a static run figure on the page where a chart could serve. The chart-first prompt rule exists, and the agent still uses the figure. The cause is in the renderer. The chart grammar cannot draw many plots of a run. The chart has a dashboard look, and the one export is a PNG at a pixel ratio of 2.

A person wants each plot for a paper or for a slide. Thus each chart must look like a journal figure, and it must export as one. This is issue #578. It replaces #329, and #329 stays open until the pull request merges.

## What Changes

- **A wider chart grammar.** The encoding gains a continuous `color` channel, a `size` channel, an interval pair `low` and `high`, and a `facet` channel. A channel object gains an `orderBy` column with an `order` direction. Thus a category axis sorts by a column of the table. The block gains a `focus` list that names the categories of the finding. The quick path gains the types `violin`, `stacked-bar`, `normalized-bar`, and `radar`. A composition series gains the same `color`, `size`, `low`, and `high` channels, and a composition gains a `facet`. The agent still authors no raw ECharts option, no data literal, and no formatter.
- **Two more computed summaries.** The violin density is a Gaussian kernel estimate on a fixed grid, with the Silverman bandwidth. The normalized bar reads the share of each part in its category. The spec names both beside the box quantiles and the histogram bins.
- **Named renderers.** The violin and the interval draw through a custom series. The derived option carries the renderer name as a string. The page script binds the function, and the server export binds the same function in TypeScript. A shared test vector holds the two twins together.
- **One publication theme.** The page and the export render one theme. Each stored chart takes the new look at its next preview. The left axis line and the bottom axis line are strong, and there is no top line, no right line, and no grid. The legend has no frame. The palette is colorblind-safe, with one focus color and muted reference colors. Each bar carries a value label when the bar count is small. The chart text uses the journal sans stack (Helvetica, Arial). The report chart carries no toolbox, because the card carries the export links.
- **The export.** The renderer makes two SVG files for each chart, as staged assets beside the data assets. A chart over the crowd row count gets no SVG, and the PNG serves it. The single column is 89 × 67 mm, and the double column is 183 × 92 mm. The bytes are deterministic. The page makes a PNG on click, from an offscreen canvas: the two column sizes at 300 DPI, and a 16:9 slide at 1920 × 1080.
- **The figure rule.** The prompt states that a figure block is the last choice, for a picture that no table can carry. It names the plots that are chart blocks. The figure block gains no field.
- **The design fixture** covers each new chart form and the publication look.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-block-model`: the chart grammar gains the channels, the order, the focus, the facet, and the four forms.
- `report-render`: the derivation of the new channels and forms, and the two computed summaries. Also the named renderers, the SVG export, the download links, and the toolbox removal.
- `report-design-system`: the publication theme, the export row and the facet height of the chart card, the chart font exception, and the fixture coverage.
- `report-session-agent`: the prompt carries the figure-last rule.

## Impact

- Code: `src/contracts/report-blocks.ts`, `src/report-model/block-walk.ts`, `src/report-render/chart.ts`, `chart-presets.ts`, `design.ts`, `page.ts`, `render.ts`, `types.ts`, `views/chart-view.tsx`, `views/page-view.tsx`, `fixture.ts`, `src/tools/report-session/preview-report.ts`, and `src/prompts/report-session.ts`. Two new modules hold the SVG export and the named renderers.
- Dependencies: none. ECharts 6.1.0 already renders an SVG in Node, and the page makes each PNG in the browser.
- Data: a stored draft that carries no new field still validates. The new fields are optional. Its charts take the theme, the value labels, and the export row at the next preview.
- Embedders: a chart card links two SVG assets. An embedder that stages the assets itself already writes each data asset of the render, and the SVG rides the same list.
- Tests: the chart derivation, the render, the fixture, the validity gate, and the block walk. Also a shared vector between the page script and the server, for the transforms and the renderers.
