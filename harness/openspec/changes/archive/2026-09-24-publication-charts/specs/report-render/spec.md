# Spec Delta

## MODIFIED Requirements

### Requirement: The chart option derives, and the layout discipline applies
The renderer MUST derive the ECharts option object from the chart type, the encoding, and the resolved rows. The derived option MUST pass through `normalizeEchartSpec` before it inlines. The container id MUST derive from the block id.

A report chart MUST carry no toolbox, because the chart card carries the export links. The derivation removes the toolbox that the layout discipline injects, and each other rule of the discipline stays.

#### Scenario: A bar chart derives its axes from the encoding
- **WHEN** the caller renders a bar chart with `x` and `y` in the encoding and resolved rows
- **THEN** the inline option holds the category axis from `x` and the values from `y`

#### Scenario: The normalize discipline applies
- **WHEN** the caller renders a chart block
- **THEN** the inline option carries the normalized layout, and it carries no in-spec title

#### Scenario: The report chart carries no toolbox
- **WHEN** the caller renders a chart block
- **THEN** the inline option holds no toolbox member, and the legend and the axis rules of the discipline stay

### Requirement: The per-type derivation rules
The renderer MUST hold one fixed derivation rule for each chart type. A chart whose encoding lacks a column that its type demands MUST give a `RenderProblem`. The renderer MUST compute no aggregate outside the named summaries, and a pie or heatmap entry with a repeated category MUST give a `RenderProblem`. Category order and group order MUST follow the first appearance in the rows, unless a channel carries an `orderBy`.

The named summaries are four. The histogram MUST bin with the auto rule: the larger of the Sturges count and the Freedman-Diaconis count. The box MUST compute type-7 quantiles with Tukey fences at 1.5 IQR. The violin MUST compute a Gaussian kernel density with the Silverman bandwidth, on a fixed grid of 64 points over the range of the category. The bandwidth reads the sample standard deviation and the type-7 quartiles, and it falls to the standard deviation alone when the IQR is zero. A category with fewer than five values, or with a bandwidth of zero, draws no violin. Each violin carries its median and its quartiles as an inner mark, from the same type-7 quantiles. The normalized bar MUST compute the share of each part in the total of its category. A category whose total is zero draws no bar, and a negative part refuses with its row.

The `stacked-bar`, the `normalized-bar`, and the `radar` MUST demand a `group` channel, because each one draws the parts of a category. The `stacked-bar` MUST stack the groups of one category, in group order. The `normalized-bar` MUST stack the shares, and its value axis runs from zero to one. The `radar` MUST draw one polygon for each group over the categories of `x` as the indicators. The indicator bound is the largest `y` value of the table, and a radar whose table holds no positive `y` value refuses. Each of the four new types keeps its data inline, whatever the size of the option. A chart of a new type with zero rows keeps its container, as every other chart does. A stacked form, a radar, a violin, and a heatmap each lay out one slot for each category and group pair. Such a chart MUST refuse when the slot count passes the slot bound of the design source, and the problem names the count.

A chart with an auxiliary series (an interval, an outline, or a facet panel) MUST state the legend entries from the names of the drawn series. Thus no auxiliary series shows an orphan legend entry.

#### Scenario: The histogram bins deterministically
- **WHEN** the caller renders a histogram over the same rows two times
- **THEN** the two pages hold the same bin edges, and the bin count follows the auto rule

#### Scenario: The box computes the summary
- **WHEN** the caller renders a box chart over a category with seven numeric values
- **THEN** the inline option holds the type-7 five-number summary, and each outlier sits in a paired scatter series

#### Scenario: A repeated pie category refuses
- **WHEN** the caller renders a pie whose rows hold one category two times
- **THEN** the render returns a `RenderProblem` that names the block id and the repeated category

#### Scenario: The heatmap grid is dense
- **WHEN** the caller renders a heatmap whose rows lack one pair of x and y
- **THEN** the inline option holds a cell for every pair, and the absent pair holds a null value

#### Scenario: The order follows first appearance
- **WHEN** the caller renders a bar chart whose categories first appear as Day2, Day10, Day1
- **THEN** the category axis lists Day2, Day10, Day1 in that order

#### Scenario: The violin computes the density
- **WHEN** the caller renders a violin over a category with twenty numeric values two times
- **THEN** the two options hold the same 64 grid points and the same densities, and the outline is symmetric about the category

#### Scenario: A thin violin category draws nothing
- **WHEN** a violin category holds four values
- **THEN** the option holds no outline for that category, and the other categories draw

#### Scenario: A tied violin category keeps its bandwidth
- **WHEN** a violin category holds twenty values whose quartiles are equal and whose standard deviation is not zero
- **THEN** the bandwidth reads the standard deviation, and the outline draws

#### Scenario: The normalized bar sums to one
- **WHEN** the caller renders a normalized bar over a category with the parts 3, 1, and 4
- **THEN** the three stacked shares are 0.375, 0.125, and 0.5, and the value axis ends at one

#### Scenario: A stacked form without a group refuses
- **WHEN** the caller renders a `stacked-bar` with no `group` channel
- **THEN** the render returns a `RenderProblem` that names the block id and the absent channel

#### Scenario: The radar draws one polygon for each group
- **WHEN** the caller renders a radar with five categories on `x` and two groups
- **THEN** the option holds five indicators and two polygons, the indicator bound is the largest `y` value, and the legend names the two groups

#### Scenario: An empty new form keeps its container
- **WHEN** the caller renders a violin, a stacked bar, a normalized bar, or a radar with zero rows
- **THEN** the page holds the chart container, and the render returns no problem

## ADDED Requirements

### Requirement: The wide grammar derives
The renderer MUST derive each new channel as content, with no style field on the block. A row whose `color`, `size`, `low`, or `high` cell is not numeric drops, as a row with no `x` value drops. An `orderBy` key that is not numeric compares as text.

A `color` channel MUST derive a continuous visual map over the numeric column. A column whose values cross zero takes the diverging scale centered on zero, and every other column takes the sequential scale. The heatmap `value` reads the same zero-crossing rule. A `color` channel is legal on a scatter and on a bar, and a refusal names each other form. A `size` channel MUST derive a second visual map over the symbol size, on a scatter alone. A series with a `color` or a `size` channel takes no large-render path, because that path draws one fill. A `color` channel beside a `group` channel is a refusal, because one chart colors by one channel.

A `low` channel and a `high` channel MUST derive an interval around each plotted value, through the named `interval` renderer. The interval lies along the value axis: on a bar it is the value axis of the orientation, and on a scatter it is the axis that draws no category. On a grouped bar each interval sits over its own bar, at the band offset of its group. A row whose bound sits on the wrong side of its value is a refusal that names the row. The interval is legal on a bar and a scatter, and a refusal names each other form. The interval series carries no legend entry.

A `facet` channel MUST split the table into one panel for each category value, in first-appearance order. Each panel carries its own axis pair and one label, and the panels share one axis range on each axis. One panel takes the full width after the title band and the scale band. Two panels take half of that width each, and three or more lay out three to a row. The chart card grows one row of height for each row of panels. A facet is legal on a scatter, a line, and a bar. A facet with more than twelve panels is a refusal.

An `orderBy` on a category channel MUST sort the categories in the declared direction. The sort key of a category is the value of the named column. That value MUST be one value across the rows of the category. A category whose rows hold two different keys refuses, and the refusal names the category. A tie between categories keeps the first-appearance order. The heatmap reads an order on `x` and on `y` alike.

A `focus` list MUST color each named category with the one focus color, and mute every other category. On a bar with no group the categories are the values of `x`. On a chart with a group channel the categories are the group values. A focus is legal on a bar and the two stacked forms, and on a grouped scatter, line, box, violin, and radar. A focus beside a `color` channel refuses, and a focus value that no category holds refuses.

Each bar item of a bar chart with twelve items or fewer, counted across the series, MUST carry a value label. The label text is the shown form of the number helper, as a static per-item string. The label of a negative bar sits under its end. The stacked forms carry no value label. A bar that carries an interval carries no value label, because the whisker stands where the label would stand.

A bar that derives through the composition MUST keep zero on its value axis, as the base bar rule does. Each bar series states a category gap of 20 percent, thus an interval sits over the center of its own bar.

A composition MUST refuse an `orderBy` on a series after the first, because the axes read the first series. A `line`, an `area`, or a `step` over an ordered category axis draws its points in the order of that axis. A composition whose series name two different `color` columns, or two different `size` columns, MUST refuse, because one chart colors by one channel. A focus on a grouped `area` or `step` series MUST refuse.

A `color` channel and a `size` channel MUST join the payload descriptor of a dense chart. Thus an embedding colored by expression reads the registered payload past the inline bound. A block with an interval or a facet takes no payload pass, and it keeps its rows inline.

#### Scenario: An embedding colors by expression
- **WHEN** the caller derives a scatter with a `color` channel over a column that holds no negative value
- **THEN** the option holds one continuous visual map over the color dimension with the sequential scale, and the series takes no large-render path

#### Scenario: A fold change colors on the diverging scale
- **WHEN** the caller derives a scatter with a `color` channel over a column that crosses zero
- **THEN** the visual map takes the diverging scale, and zero sits at its center

#### Scenario: A z-score heatmap diverges
- **WHEN** the caller derives a heatmap whose `value` column crosses zero
- **THEN** the visual map takes the diverging scale, and zero sits at its center

#### Scenario: The dot plot sizes by count
- **WHEN** the caller derives a scatter with a `size` channel and a `color` channel
- **THEN** the option holds two visual maps, one over the symbol size and one over the color

#### Scenario: A non-numeric color cell drops its row
- **WHEN** one row of a colored scatter holds the text `NA` in the color column
- **THEN** that row draws no point, and the other rows draw

#### Scenario: A forest plot draws its intervals
- **WHEN** the caller derives a scatter whose `y` is a category column with `low` and `high` channels
- **THEN** the option holds one custom series that names the `interval` renderer, and each item carries the value and its two bounds along `x`

#### Scenario: A grouped bar keeps each interval over its bar
- **WHEN** the caller derives a grouped bar with `low` and `high` channels over two groups
- **THEN** each interval item carries the band offset of its group, and the two offsets differ

#### Scenario: A reversed bound refuses
- **WHEN** a row holds a `low` value above its plotted value
- **THEN** the render returns a `RenderProblem` that names the block id and the row

#### Scenario: A facet splits the table
- **WHEN** the caller derives a scatter with a `facet` channel of four values
- **THEN** the option holds four grids in a two-row layout, one axis pair for each grid with one shared range, and four panel labels

#### Scenario: A wide facet refuses
- **WHEN** the caller derives a scatter with a `facet` channel of thirteen values
- **THEN** the render returns a `RenderProblem` that names the block id and the panel count

#### Scenario: The leaf order sorts the heatmap
- **WHEN** the caller derives a heatmap whose `x` and `y` channels carry `orderBy` on two leaf-order columns
- **THEN** the two category axes list the values in the order of those columns

#### Scenario: A conflicting order key refuses
- **WHEN** one category holds two different values in its `orderBy` column
- **THEN** the render returns a `RenderProblem` that names the block id and the category

#### Scenario: The focus colors the finding
- **WHEN** the caller derives a bar with a `focus` list of two categories
- **THEN** the two bars carry the one focus color, and each other bar carries the muted color

#### Scenario: A small bar chart labels its values
- **WHEN** the caller derives a bar over six categories
- **THEN** each item carries a static label with the shown form of its value, and no function rides the option

#### Scenario: A busy bar chart carries no labels
- **WHEN** the caller derives a bar over thirty categories
- **THEN** no item carries a value label

#### Scenario: A bar with an interval carries no label
- **WHEN** the caller derives a bar of six categories with `low` and `high` channels
- **THEN** no item carries a value label, and the value axis keeps zero

#### Scenario: A sparse dense grid refuses past the slot bound
- **WHEN** the caller derives a stacked bar over 400 categories and 300 groups
- **THEN** the render returns a `RenderProblem` that names the block id and the slot count

#### Scenario: An ordered line draws along its axis
- **WHEN** the caller derives a line whose `x` channel carries an `orderBy` that gives the axis B, C, A
- **THEN** the points of the line come in the order B, C, A

#### Scenario: A later series refuses an order
- **WHEN** the second series of a composition carries an `orderBy` on its `x` channel
- **THEN** the render returns a `RenderProblem` that names the block id and the series place

#### Scenario: Two color columns refuse
- **WHEN** two series of a composition name two different `color` columns
- **THEN** the render returns a `RenderProblem` that names the block id

#### Scenario: A dense colored scatter reads the payload
- **WHEN** the caller renders a scatter with a `color` channel whose option exceeds the inline bound
- **THEN** the descriptor names the color column, and the page builds the colored items from the payload

#### Scenario: A dense interval scatter stays inline
- **WHEN** the caller renders a scatter with `low` and `high` channels whose option exceeds the inline bound
- **THEN** the option keeps its rows inline, and each interval draws

### Requirement: The named renderers
A form that ECharts draws through a custom series MUST reach the page as a renderer name in the option, never as a function. The names are `interval` and `outline`. Each item of such a series leads with its axis extent, and the series names those dimensions for the axis. The page script MUST hold the function of each name and bind it before the option reaches the chart runtime. The server export MUST bind the same function in TypeScript. A shared test vector MUST run the two twins over one set of items and compare the elements that they give. The same rule holds for the series builder of the payload path: one shared vector MUST run the page twin and the server twin over the transforms and the item forms, the four-member item included.

#### Scenario: The option carries a name, not a function
- **WHEN** the caller derives a violin
- **THEN** the custom series carries the string `outline` as its renderer, and the inline JSON holds no function

#### Scenario: The twins agree
- **WHEN** the shared vector runs through the page renderer and the server renderer
- **THEN** the two give identical element descriptions for every item

#### Scenario: The custom series feeds the axis
- **WHEN** the caller renders a bar with an interval whose `high` bound passes the largest bar
- **THEN** the value axis of the SVG covers the bound, and the cap sits inside the plot

### Requirement: The chart exports as a publication file
The renderer MUST make two SVG files for each chart block through the server-side render of the chart runtime: one at the single column of 89 × 67 mm, and one at the double column of 183 × 92 mm. Each SVG renders the option of the chart with its full rows, in the same theme, at the print text size. It holds no toolbox, no tooltip, and no animation. The root element states the size in millimeters, and the view box keeps the pixel space. The bytes MUST be deterministic: two renders of one document give byte-identical files, and the renderer renumbers each instance-scoped token of the chart runtime in order of appearance. Each SVG rides the render result as a staged data asset with a content-addressed name, and never as a page script. The caller stages it beside the page.

The export MUST carry a bound. A chart whose plotted point count passes the crowd row count gets no SVG, and the export row states that the PNG serves it. The count reads the drawn coordinates: an empty slot counts nothing, a radar counts one coordinate for each indicator, and a violin outline counts each vertex that it draws.

The chart card MUST carry an export row under the chart body: a link to each SVG, and one control for each PNG. The page MUST make each PNG on click from an offscreen canvas of the chart runtime, with the same option and theme. The single column and the double column render at 300 DPI at the print text size. The 16:9 slide renders at 1920 × 1080 pixels at the slide text size. The export row is hidden in print.

#### Scenario: The SVG assets ride the render
- **WHEN** the caller renders a document with one chart block
- **THEN** the data assets hold two SVG entries for that block, and the page holds no script tag for them. The export row links both by their relative paths

#### Scenario: The SVG is deterministic
- **WHEN** the caller renders one document two times, with a chart that holds a gradient and a clip path
- **THEN** the two SVG assets of each chart are byte-identical, and their names match

#### Scenario: The export carries no page chrome
- **WHEN** the caller inspects the SVG of a chart
- **THEN** the file holds the axes, the series, and the legend, and it holds no toolbox and no tooltip

#### Scenario: The root states the column size
- **WHEN** the caller inspects the single-column SVG
- **THEN** the root element carries a width of `89mm` and a height of `67mm`, and the view box is 336 by 253

#### Scenario: A dense chart exports its rows
- **WHEN** the caller renders a chart whose page option reads the payload
- **THEN** the SVG holds every plotted point, because the export reads the full rows

#### Scenario: A crowded chart gets no SVG
- **WHEN** the caller renders a scatter whose plotted point count passes the crowd row count
- **THEN** the data assets hold no SVG for it, and the export row states that the PNG serves the chart

#### Scenario: The page makes the PNG
- **WHEN** a reader clicks the single-column PNG control
- **THEN** the page script draws the chart offscreen at 1050 pixels wide and downloads the PNG

#### Scenario: The slide PNG is 16:9
- **WHEN** a reader clicks the slide PNG control
- **THEN** the page script draws the chart offscreen at 1920 × 1080 pixels and downloads the PNG
