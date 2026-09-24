# Tasks

Each task names its proof. A proof is a test, a command, or a read of an output.

## 1. The grammar

- [x] 1.1 Add `color`, `size`, `low`, `high`, and `facet` to the quick-path encoding in `src/contracts/report-blocks.ts` (D1). Add `color`, `size`, `low`, and `high` to the series encoding, and `facet` to the composition. Add the refine that holds `low` and `high` together. Proof: parse tests show that the dot plot parses and that a lone `low` refuses.
- [x] 1.2 Make `transform` optional on the channel object, and add `orderBy` and `order` to it, with the refine that refuses `order` alone (D1). Add `focus` to the chart block. Add `violin`, `stacked-bar`, `normalized-bar`, and `radar` to the chart type enum. Let the two stacked forms read the orientation. Proof: parse tests show that an ordered channel parses with no transform, that `order` without `orderBy` refuses, and that a focus list parses.
- [x] 1.3 Add the five channels, the `orderBy` of each channel, the series members, and the composition `facet` to `chartColumns` in `src/report-model/block-walk.ts`. Proof: a block-walk test and a structural-validation test show the refusal of a `color` column, a composition `facet` column, and an `orderBy` column outside the table.
- [x] 1.4 Write the teaching text of each new field, thus the authoring schema tells the agent what each channel is. Proof: the parse tests read each field description.

## 2. The named renderers

- [x] 2.1 Make `src/report-render/chart-renderers.ts` with the `interval` and the `outline` renderers, as TypeScript functions and as page source text (D2). Each item leads with its axis extent, and the series names those dimensions in `encode`. Proof: a test binds the page text through `new Function`, and it runs both twins over one shared item vector with a stub `api`. The test compares the elements. A second test renders one interval and one outline through the SSR path, and it reads the element positions of the SVG.
- [x] 2.2 Bind the renderer names in `CHART_BOOTSTRAP` before `setOption`, and keep the option of each chart by container id (D2, D11). Proof: a page test shows that the bootstrap text holds the two names and the bind step.

## 3. The derivation

- [x] 3.1 Derive the `color` and `size` visual maps on a scatter, and the `color` map on a bar (D5). A column that crosses zero takes the diverging ramp, and each other column takes the sequential ramp. Apply the zero-crossing rule to the heatmap `value` too. Drop the large-render path on a colored or sized series. Move the viridis ramp into `design.ts`, and add the diverging ramp. Proof: chart tests cover the embedding, the fold change, the z-score heatmap, and the dot plot scenarios. `color` beside `group` refuses, `color` on a line refuses, and `size` on a bar refuses. A non-numeric color cell drops its row.
- [x] 3.2 Add `color` and `size` to the payload descriptor and to `CHART_SERIES_BUILDER` (D5). Proof: the shared vector test shows that a dense colored scatter reads the payload, and that the page twin builds the four-member item.
- [x] 3.3 Derive the interval as a custom series with the `interval` renderer, on a bar and on a scatter (D6). A grouped bar gives each item its band offset. Make `perRowQuickPath` give `undefined` for a block with an interval or a facet. State `legend.data` from the drawn series when an auxiliary series exists. Proof: chart tests cover the forest plot scenario, the bar interval on the value axis of each orientation, and the grouped-bar offsets. A reversed bound refuses with the row, and an interval on a line refuses. A dense interval scatter stays inline, and the legend holds no auxiliary entry.
- [x] 3.4 Derive the `orderBy` sort of a category channel, on a bar, a box, a violin, and a heatmap on both axes (D1). Proof: chart tests cover the leaf-order heatmap scenario. A tie keeps first appearance, and a conflicting key inside one category refuses. A text key compares as text, and `orderBy` on a value channel refuses.
- [x] 3.5 Derive the one focus color on a bar with no group and on a grouped chart (D8). Proof: chart tests cover the focus scenario with two named categories. A focus value outside the categories refuses, a focus on a pie refuses, and a focus beside a `color` channel refuses.
- [x] 3.6 Derive the value labels of a bar of twelve items or fewer, counted across the series, as per-item static strings through the number helper (D8). Proof: chart tests show that six bars carry labels with the shown form, and that thirty bars carry none. A stacked bar carries none, and no function rides the option.
- [x] 3.7 Derive the `violin` with the Gaussian density, the Silverman bandwidth, and the 64-point grid (D3). It is a custom series with the `outline` renderer and the inner median mark. Proof: chart tests show that the density scenario is deterministic and symmetric. A category of four values draws nothing, and a tied category falls to the standard deviation. A group channel gives one outline for each group, and an orientation on a violin refuses at render.
- [x] 3.8 Derive the `stacked-bar`, the `normalized-bar`, and the `radar` (D4). Proof: chart tests show that the stacked bar names one stack on each group series. The shares are 0.375, 0.125, and 0.5 with the axis at one. A zero total draws no bar, a negative part refuses, and an absent group refuses. A radar holds five indicators and two polygons with both names in the legend. Each new form with zero rows keeps its container.
- [x] 3.9 Derive the `facet` as one grid, one axis pair with a shared range, and one graphic label for each panel, at most twelve panels (D7). Return the panel row count. Proof: chart tests show that four facets give two rows and four labels with one shared range. One facet takes the full width, thirteen facets refuse, and a facet on a pie refuses. A facet keeps its rows inline past the bound.
- [x] 3.10 Delete the toolbox after `normalizeEchartSpec` in the report derivation (D9). Proof: a chart test shows that no option holds a toolbox, and that the legend and axis rules stay.

## 4. The theme and the card

- [x] 4.1 Replace `ECHARTS_THEME` with the publication theme, and add the text-size function for the page, the export, and the slide (D9). Proof: a design test shows the Okabe-Ito palette, the left and bottom axis lines, and the hidden split lines. It also shows the frameless legend and the font stack with Helvetica and Arial.
- [x] 4.2 Add the export row to `views/chart-view.tsx`, with the two SVG links, the PNG-only note, the three PNG buttons, and the facet height class (D7, D11). Add the row and the height classes to `DESIGN_CSS`, with the print rule that hides the row. Proof: a render test shows the row and the two-row height class of a faceted chart. The validity gate passes for the HTML and the CSS.

## 5. The SVG export and the PNG download

- [x] 5.1 Make `src/report-render/chart-export.ts` with `renderChartSvg` and `chartSvgAssets` (D10). Add the export sizes to `design.ts`, the millimeter root size, the export bound, and the zrender token renumber. Proof: an export test renders an option with a gradient and a clip path two times, and the two results are byte-identical. The SVG holds no toolbox and no tooltip. The root reads `89mm` by `67mm` with a view box of 336 by 253, and a chart past the crowd row count gives no asset.
- [x] 5.2 Return the inline option from `deriveChartRender` (D10). Add the two SVG assets to the staged `dataAssets` of the result in `render.ts`. Never add them to the script list of `assemblePage`. Link them from the card. Proof: a render test shows two SVG entries for one chart and no script tag for them. The names are the same across two renders, the links name them, and the SVG of a dense chart holds the full rows.
- [x] 5.3 Add the PNG download to `CHART_BOOTSTRAP` (D11). The offscreen canvas draws the two column sizes at 300 DPI at the print text size, and the slide size at the slide text size. Proof: a page test shows that the bootstrap text names the three sizes, the two text sizes, and the download step. A headless capture of the fixture page shows that a click downloads a PNG of 1050 px width.

## 6. The prompt, the fixture, and the proof

- [x] 6.1 Add the figure-last rule to `src/prompts/report-session.ts`, with the permitted uses, the named chart plots, and the "Do NOT" entry (D12). Proof: the prompt test shows that the rule and the entry are present.
- [x] 6.2 Extend the fixture document and its values in `fixture.ts` (D9). Add one chart of each base type, one of each preset, one interval, one facet, one focus, and one continuous color. Proof: the fixture test shows each form, the render passes, and the validity gate passes.
- [x] 6.3 Run `bun run design:fixture`, open the page in a headless browser, and capture it. Proof: a read of the capture shows the publication look on each chart, each violin and each interval, and the labels of the facet panels.
- [x] 6.4 Run `bun run format:file` on each changed source file, then `bun run typecheck`, `bun run lint`, and the full `bun test` one time. Proof: each command passes.
