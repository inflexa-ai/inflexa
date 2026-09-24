# Design

## Context

See `proposal.md` for the motivation. The facts that shape the approach:

- The grammar is `src/contracts/report-blocks.ts`. The derivation is `src/report-render/chart.ts`, with the presets in `chart-presets.ts`. The theme is `ECHARTS_THEME` in `design.ts`. The page bootstrap is `CHART_BOOTSTRAP` in `page.ts`, and it already holds a source-text twin of the derivation (`CHART_SERIES_BUILDER`) with a shared test vector. The structural tier collects each grammar column in `src/report-model/block-walk.ts` (`chartColumns`).
- `renderReportPage` is pure and synchronous. It returns the page and a list of text data assets. The preview tool and the fixture script both stage each asset of the result beside the page. `assemblePage` takes a second list, the table payloads, and it emits one `<script src>` tag for each entry of that list. The two lists are not one list.
- ECharts 6.1.0 renders an option to an SVG string in Node with `init(null, null, { renderer: "svg", ssr: true, width, height })` and `renderToSVGString()`. A `custom` series with a `renderItem` function renders there. Two renders of one option differ in the zrender tokens (`zr0-cls-0` against `zr1-cls-2`), because the instance counter and the class counter are process-global. A gradient and a clip path emit tokens of the same family.
- A category axis rounds a numeric value, thus `api.coord([c + 0.3, y])` lands on a category and not beside it. A custom renderer takes a width in pixels from `api.size([1, 0])[0]`, which is the band of one category.
- A custom series takes its axis extent from the dimensions that `encode` names. Without an `encode`, the extent reads dimensions 0 and 1 alone.
- The large-render path of a scatter (`large: true`) draws one fill, and it reads no per-point color of a visual map.
- A 300 DPI PNG in Node needs a canvas library. The page has a canvas.
- The option goes to the page as inline JSON, thus it holds no function (#372). The agent authors no raw option.
- The user constraint: no inflexa run and no LLM call in this change. The permitted proofs are a unit test, a render test, the fixture script, and a headless capture of the fixture page. A read of the SVG output is permitted too.
- figures4papers is CC BY-NC 4.0. The theme takes its principles and nothing else.

## Goals / Non-Goals

**Goals:**

- Each new channel names content, and the block gains no style field.
- The derivation and the SVG export stay pure functions of the document and the rows.
- One theme, one look, on the page and in the export.
- The page twin and the server twin of each renderer, and of the series builder, cannot drift in silence.
- Each operation whose cost grows with the row count carries a bound.

**Non-Goals:**

- A PNG from the server. The page makes each PNG.
- A facet or an interval on the payload path. Both keep their rows inline in this change.
- A new preset. A forest plot composes as a scatter with an interval and a reference line.
- A change of `normalizeEchartSpec` for the `show_user` path.
- A violin in a composition. The violin is a quick-path type, as the box is.

## Decisions

### D1. The grammar shape

- The quick-path encoding gains `color`, `size`, `low`, `high`, and `facet`, each a `ChartChannel`. A series encoding gains `color`, `size`, `low`, and `high`. The composition gains `facet`.
- A refine holds `low` and `high` together on each encoding. The other channel rules are render refusals, because they depend on the chart type. The rules are: `color` on a scatter or a bar, and `size` on a scatter. The interval is legal on a bar or a scatter. `orderBy` is legal on a category channel. `facet` is legal on a scatter, a line, or a bar.
- The object form of a channel becomes `{ column, transform?, orderBy?, order? }`. `transform` turns optional, because an ordered channel carries none. A refine refuses `order` without `orderBy`. The order lives on the channel, because the heatmap orders `x` and `y` apart. The name `order` matches the point-labels annotation and the row bound.
- The block gains `focus?: string[]` (one value at least). It applies to the quick path and to the composition, because a composition series with a group channel reads it too.
- The chart type enum gains `violin`, `stacked-bar`, `normalized-bar`, and `radar`. The bar orientation applies to the two stacked forms. The series form enum does not grow. The two stacked forms and the radar demand a `group` channel, because each one draws the parts of a category.
- `chartColumns` in `block-walk.ts` adds the five channels of the quick path and the `orderBy` of each channel. It also adds the four channels of each series and the `facet` of the composition. Thus the structural tier refuses an invented column.

Alternative: a top-level `order` member on the encoding. Rejected, because the heatmap needs two orders.

Implementation note: a `line`, an `area`, or a `step` over an ordered category axis draws its points in the order of the axis. Such a series keeps its rows inline, because the page build sorts by the cells.

### D2. The named renderers

A new module `src/report-render/chart-renderers.ts` holds two renderers, `interval` and `outline`, in two twins:

- the TypeScript functions, which the server export binds.
- the same functions as page source text, which the bootstrap binds.

Each item of a custom series leads with its axis extent, and `encode` names those dimensions. Thus the axis of the chart covers each bound and each outline:

- `interval`: an item is `[x, y, low, high, axis, offset]`. `axis` is `0` for an interval along `x` and `1` for one along `y`. `offset` is a fraction of one category band. For a grouped bar the derivation computes it from the place and the count of the group (`-0.4 + (place + 0.5) * 0.8 / count`). Elsewhere it is `0`. The renderer maps the anchor through `api.coord`, shifts it by `offset * api.size([1, 0])[0]` (or the `y` band along `y`), draws one line between the two bounds, and adds two caps. The `encode` names `[x, low, high]` on the interval axis and the value on the other axis.
- `outline`: an item is `[c, yMin, yMax, w1, y1, w2, y2, ...]`. `c` is the category index, and `yMin` and `yMax` are the extent of the grid. Each pair is a half-width in band fractions with its grid value. The renderer maps `[c, y]` through `api.coord` for each pair. It shifts the x by `w * api.size([1, 0])[0]`, to the right for the right side and to the left for the left side. Then it returns one closed polygon. The `encode` names `c` on `x` and `[yMin, yMax]` on `y`.

The derived series carries `renderItem: "interval"` or `renderItem: "outline"` as a string. The bootstrap and the export both replace the string with the function before `setOption`. A shared test vector runs the two twins over one set of items. The stub `api` has an identity `coord` and a `size` that gives a fixed band. The test compares the returned elements. A second test renders one interval and one outline through the SSR path, and it reads the element positions of the SVG. This is the pattern of `CHART_SERIES_BUILDER`.

Alternative: `Function.prototype.toString()` of the TypeScript function as the page text. Rejected, because the transpiled text differs between bun and tsc, and the test vector already holds the twins together.

Implementation note: two item layouts grew by one member each.

- The `interval` item is `[x, y, low, high, axis, offset, mark]`. `mark` is `0` for an error bar with two caps, and `1` for the inner mark of a violin: a thick quartile line and one light point at the median. A scatter point cannot take the slot offset of a grouped violin, thus the median point draws inside the renderer.
- The `outline` item is `[c, yMin, yMax, offset, w1, y1, ...]`. The `offset` moves a grouped violin inside its band, as D3 states.
- The export option (D10, D11) is a third twin in the same module, with its own shared vector.

### D3. The violin

The density is a Gaussian kernel estimate over the values of one category and group. The bandwidth is the Silverman rule, `0.9 * min(sd, IQR / 1.34) * n^(-1/5)`, with the sample standard deviation (`n - 1`) and the type-7 quartiles of the box rule. When the IQR is zero, the bandwidth reads `0.9 * sd * n^(-1/5)`. The grid holds 64 points from the minimum to the maximum of the values. A category with fewer than five values, or with a bandwidth of zero, draws nothing. The half-width at each grid point is the density over the largest density of the chart, times `0.4` of one band. The outline runs up the right side and down the left side, and it closes. Each violin carries its median as one point and its quartiles as an inner interval, through the `interval` renderer, from the same type-7 quantiles. A group channel draws one violin for each group, offset inside the band as the grouped bar is. The math sits beside the box math in `chart.ts`.

### D4. The stacked forms and the radar

- `stacked-bar`: the bar rule with `stack: "total"` on each group series.
- `normalized-bar`: the share of each part in its category, `stack: "total"`, and a value axis with `max: 1`. A category with a total of zero draws no bar. A negative part refuses, and the refusal names the row.
- `radar`: the categories of `x` are the indicators, in order, with `max` at the largest `y` value of the table. One data item for each group holds the values in indicator order, and an absent pair holds `null`. The option carries a `radar` coordinate and no cartesian axis, thus the layout discipline applies no grid rule to it.
- A chart with an auxiliary series (an interval, an outline, a facet panel) states `legend.data` from the names of the drawn series. Thus no auxiliary series shows an orphan legend entry, and a radar of two groups reads both names.

Implementation note: a stacked form, a radar, a violin, and a heatmap lay out one slot for each pair of a category and a group. The render refuses a chart past `CHART_SLOT_LIMIT` (100,000 slots in `design.ts`), and the problem names the count. The violin puts the values into their slots in one pass over the rows.

### D5. The continuous channels

- `color` derives one continuous `visualMap` over the color dimension of the item. A column that crosses zero takes the diverging ramp centered on zero (`min = -m`, `max = m`, with `m` the largest absolute value). Every other column takes the sequential ramp. The heatmap `value` reads the same zero-crossing rule, thus a z-score heatmap diverges. The ramps are constants of `design.ts`. The sequential ramp is the viridis ramp that the heatmap holds today, moved into the design source. The diverging ramp runs from the palette blue through a near-white to the palette vermilion.
- `size` derives a second `visualMap` with `inRange.symbolSize` between two constants and `show: false`.
- A scatter item with either channel takes the array form `[x, y, color?, size?]`, and each visual map names its dimension. A named point keeps the object form with the same array as its value. A series with either channel drops the large-render path, because that path draws one fill. The crowd symbol size and opacity still apply.
- A row whose `color`, `size`, `low`, or `high` cell is not numeric drops, as a row with no `x` drops. An `orderBy` key that is not numeric compares as text, through the compare of the sort.
- The payload descriptor gains `color` and `size` column sources. The page twin builds the same array form. The shared vector of the series builder covers the four-member item. Thus a dense colored scatter reads the payload.

Implementation note: a size sits at dimension 3 of an item that carries a color, and at dimension 2 of one that carries none. Each dimension takes its own size map, and the maps share one range over the drawn points of every sized series. Thus one value draws at one size in each series. A color always sits at dimension 2, and one color map covers every colored series.

### D6. The interval

The interval sits on the value axis. For a bar it is the value axis of the orientation. For a scatter it is the axis that draws no category, and the `y` axis when both axes are value axes. The derivation emits one `custom` series after the series that it annotates, with the `interval` renderer. The series holds one item for each row that has a value and its two bounds. A grouped bar gives each item the band offset of its group (D2). A row whose bound sits on the wrong side of its value is a refusal that names the row. The interval series carries `silent: true`, and the legend names it not (D4).

A block with `low` and `high` takes no second derivation pass past the inline bound: `perRowQuickPath` gives `undefined` for it, and the chart keeps its rows inline.

Implementation note: a bar with a wide channel derives through the composition. The value axis of a composition bar carries no `scale`, thus the axis holds zero and each bar keeps its true height. Each bar series states `barCategoryGap: "20%"`, and the slot offset reads a span of 80 percent. Without that field, ECharts 6.1 computes a gap from the series count (`max(35 - 4n, 15)%`). The interval series draws at `z: 3`, over the bars. A bar that carries an interval takes no value label, because the whisker stands where the label would stand.

### D7. The facet

The facet is legal on a scatter, a line, and a bar. On a composition, the first series must have one of those forms. The derivation splits the rows by the facet value, in first-appearance order, into at most twelve panels. The option holds one `grid` for each panel, one axis pair for each grid, and each series names its `xAxisIndex` and `yAxisIndex`. The panels share one axis range on each axis, computed from every row, thus the panels compare. One panel takes the full width after the title band and the scale band. Two panels take half of that width each, and three or more lay out three to a row. The panel label is a `graphic` text element at the top left of its grid, because the layout discipline strips `title`. The chart view reads the panel row count from the derivation, and it adds one height class to the chart body (`chart-container-rows-2`, up to `-4`). The style sheet defines each class.

The facet keeps its rows inline. `perRowQuickPath` gives `undefined` for a block with a facet, thus the second pass never drops it.

Implementation note: a panel carries no axis name, because a name narrows its own panel alone. The chart carries one x title under the panels and one y title turned upright in a band at the left, both as `graphic` text. Each panel of one row takes one width. A panel axis aims at three ticks and hides a tick label that overlaps its neighbor. A faceted bar chart with value labels widens its shared value range by the label room on each side away from zero. A composition refuses an `orderBy` on a series after the first, because the axes read the first series alone.

### D8. The focus and the value labels

- A focus names category values. On a bar with no group, the categories are the values of `x`. On a chart with a group channel, the categories are the group values. Each named category takes the one focus color, which is the first palette hue, and every other category takes the muted color. A bar with no group colors each item through a per-item `itemStyle`, and a grouped chart colors each series. A focus is legal on a bar and the two stacked forms, and on a grouped scatter, line, box, violin, and radar. A focus beside a `color` channel refuses, because one chart colors by one rule. A focus value that no category holds is a refusal.
- A bar chart of twelve items or fewer, counted across the series, carries a value label on each item. The label text is the shown form of the number helper (`formatNumberCell` with `selectNumberKind`), as a per-item `label.formatter` string. Thus the option carries no function, and the plotted value stays the cell. The label sits at `top` on a vertical bar and at `right` on a horizontal bar. The stacked forms carry no value label, because the parts overlap.

Implementation note: the label of a negative bar sits at `bottom` on a vertical bar and at `left` on a horizontal bar. A labeled bar chart widens its value axis by 15 percent at each end (`boundaryGap`), thus a label past the longest bar stays inside the plot. A focus is legal on a grouped scatter, line, or bar series of a composition, and never on a grouped area or step series.

### D9. The theme

`ECHARTS_THEME` becomes the publication theme. One object holds the colors and the lines, and one function gives the theme at a text size: 12 px for the page, 10 px for the SVG and the column PNG (7.5 pt at the column width), and 24 px for the slide PNG.

- Palette: the Okabe-Ito set, in the order blue, vermilion, bluish green, orange, reddish purple, sky blue, yellow, black. The set is public and colorblind-safe, and it comes from no figures4papers file. The first hue is the focus color.
- Text: the stack `Helvetica, Arial, sans-serif`, in a near-black.
- Axes: the left line and the bottom line show, dark and 1.5 px wide, with outside ticks. Each split line hides.
- Legend: no frame, bottom placement stays.
- Tooltip: stays for the page. The export removes it.
- Toolbox: the derivation deletes the toolbox after the layout discipline runs, because the export row replaces the save button.

The `MUTED_CHART_COLOR` stays as it is. The design fixture is the visual proof.

Implementation note: ECharts 6.1.0 reads the axis style of a theme by the axis type (`categoryAxis`, `valueAxis`, `logAxis`, `timeAxis`), and never by `xAxis` or `yAxis`. Thus the theme styles the four types. A value axis sets `axisLine.onZero: false`, thus the left line and the bottom line frame the plot. A category axis keeps its line on the zero of the value axis, thus a bar stands on a zero baseline. The font stack holds no quoted family name, because the server render writes it into a double-quoted `style` attribute with no escape. A continuous color map states its `precision`, because the default of zero decimals prints a p-value of `0.001` as `0`. The heatmap scale moves to the right edge, as the color scale of a scatter does, because the bottom scale covered the x axis name.

### D10. The SVG export

A new module `src/report-render/chart-export.ts`:

- `renderChartSvg(option, size)` registers the theme one time, and it makes an SSR instance at the pixel size of the export. It sets the option with `animation: false`, no tooltip, and no toolbox, at the export text size. Then it returns the SVG string. The sizes are constants of `design.ts` at 96 CSS pixels for each inch: the single column is 336 × 253 px, and the double column is 692 × 348 px.
- The function sets the `width` and the `height` attributes of the root element to the millimeter size (`89mm`, `67mm`), and the `viewBox` keeps the pixel space. Thus a vector editor opens the file at the column width.
- The function renumbers each zrender token that matches `zr\d+-[a-z]+-?\d+` in order of first appearance, over the whole string. Thus the style block, each clip path, each gradient, and each element agree, and two renders give one byte sequence.
- `chartSvgAssets(blockId, option)` gives two `DataAsset` entries with the names `c-<hash12>-89mm.svg` and `c-<hash12>-183mm.svg`, where the hash is the content hash of the bytes.
- The export carries a bound. A chart whose plotted point count passes the crowd row count (`SCATTER_CROWD_ROWS`, 10,000) gets no SVG. The result carries no asset for it, and the export row states that the PNG serves the chart. Thus a large embedding neither stalls the render nor stages megabytes.

`deriveChartRender` returns the inline option beside the page option. The export reads the full rows, and the page option of a dense chart holds none. `render.ts` adds the two SVG entries to `RenderedPage.dataAssets`, the staged list of the result, and never to the `dataAssets` of `assemblePage`, which become script tags. The chart view links the two names. The export renders the same option as the page, thus a chart that the page shows is the chart that the paper gets.

Implementation note: `chartSvgAssets(blockId, option)` gives the two assets, or no asset past the bound.

Implementation note: the renumber reads only the places of a token (an `id` or `class` value, a `url(#...)` reference, and the style block), thus a category name that reads as a token keeps its text. The export option takes the export width. It turns the category labels whose longest name, at the export text size, passes the width of one category. Each x axis of a facet fits against the width of its own grid. It prints the ends of a color scale as static text, with the title, and no handle, at the top of the plot. The title wraps at its spaces into the scale band (18 percent of the width). Each character counts as 0.6 of the text size, thus a long title never reaches the plot. It replaces the legacy `containLabel` with the ECharts 6 containment, thus an axis name at the edge draws whole. A composition refuses two different `color` columns or two different `size` columns, and a radar refuses a table with no positive `y` value. When the chart runtime refuses to draw the option, the render returns a `RenderProblem` that names the block. The export option also keeps the labels and the names of a one-panel grid above a band of the bottom legend (`grid.outerBounds`). A column export is short, and the axis name covered the legend.

### D11. The PNG on the page

The chart view emits an export row under the chart body: two SVG links (`<a download>`), or the PNG-only note past the bound, and three buttons (`data-export="single" | "double" | "slide"`). The bootstrap keeps the option of each chart by container id. On click it makes a detached element, and it initializes a canvas instance at the CSS size of the export. The `devicePixelRatio` is 3.125 for a column (300 DPI, thus 1050 × 791 px and 2163 × 1088 px) and 1 for the slide (1920 × 1080). It sets the option with `animation: false`, no toolbox, and the export text size (10 px for a column, 24 px for the slide). Then it reads `getDataURL({ type: "png", backgroundColor: "#ffffff" })`, downloads the result through an anchor, and disposes the instance. The export row hides in print.

Implementation note: the canvas rounds each side down. A headless capture of the fixture page gives 1050 × 790 px for the single column and 2162 × 1087 px for the double column. The slide gives 1920 × 1080 px. The bootstrap keeps the options on the window global `__REPORT_CHART_OPTIONS`, thus the click handler and a test read one map.

### D12. The prompt

`report-session.ts` states the figure-last rule after the chart-first rule: the permitted figure uses, and the named plots that are chart blocks. The "Do NOT" list gains the run figure of such a plot.

## Risks / Trade-offs

- [A crowded scatter gives a large SVG, twice] → The export bound of D10 stops the SVG past 10,000 points, and the PNG serves such a chart.
- [The custom series drops the large-render path, and a colored scatter drops it too] → The interval and the outline hold few items. A colored scatter of many thousands of points draws on the normal path, with the crowd symbol size. The fixture holds one to show the cost.
- [The page fonts and the chart fonts differ] → This is the decision of the user: a figure keeps its own typography. The design spec states the exception.
- [Every stored chart changes its look] → The theme, the value labels, and the toolbox removal reach each stored draft at its next preview. A stored draft still validates, and its data renders as before.
- [The theme register in SSR is global] → `registerTheme` is idempotent, and the export registers one time for each text size.
- [A headless capture of the fixture depends on a local browser] → The capture is a manual proof of the look. The tests read the option and the SVG, and the validity gate reads the page.

## Open Questions

None.
