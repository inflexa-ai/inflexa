# report-render Specification

## Purpose

Define the deterministic renderer of a report document. A block document becomes
one HTML page through a pure function, and no agent writes markup. The inputs are
the valid `ReportDocument` and the values that resolution gives, keyed by block
id. The output is one string.

The renderer removes a class of defect by construction. An empty page, an
unrendered marker, and a local asset reference that does not resolve each exist
only when an agent can write bad markup, and here it cannot. The renderer makes
each layout decision, and it owns the escaping.

The caller adapts each `ResolvedValue` of the `report-snapshot` resolution model
into the render value union, and the caller computes the figure source. Thus the
renderer holds no policy about where image bytes live. The chart derivation obeys
the layout discipline of the `echart-layout` capability through
`normalizeEchartSpec`.

## Requirements

### Requirement: A pure and deterministic render function
The renderer MUST turn a `ReportDocument` and a value map into one HTML string. It MUST read no file, write no file, and use no clock, no random value, and no locale formatting. The same document and the same values MUST give the same bytes.

#### Scenario: The same inputs give the same bytes
- **WHEN** the caller renders the same document and the same value map two times
- **THEN** the two HTML strings are identical byte for byte

#### Scenario: The render needs only in-memory inputs
- **WHEN** the caller renders a document with values built in memory
- **THEN** the render completes with no directory and no file on disk

### Requirement: The value-map contract
The renderer MUST take the values keyed by block id, as a closed union: a scalar, a table, a figure source string, and a citation echo. The caller adapts each `ResolvedValue`, and the caller computes the figure source. A claim MUST take no value entry, because a claim renders from its references alone.

#### Scenario: A missing value is a typed problem
- **WHEN** the caller renders a document with a metric block and no value entry for it
- **THEN** the render returns a `RenderProblem` that names the block id, and no HTML string

#### Scenario: A wrong value shape is a typed problem
- **WHEN** the caller renders a chart block whose value entry is a scalar
- **THEN** the render returns a `RenderProblem` that names the block id and the expected shape

#### Scenario: The problems collect
- **WHEN** two blocks lack their value entries
- **THEN** the render returns both problems in one result

### Requirement: A rendered form for each block kind
The renderer MUST give each of the eight block kinds a rendered form. The renderer makes each layout decision, and no markup comes from the document.

A text block with a list MUST render the list after its prose paragraphs, as ordered or unordered list markup by the flag. Each item escapes exactly as a paragraph does, and the list fills the content column. A text block with a list and an empty prose renders the list alone.

The table block MUST render through the grid over its payload, and the payload holds the rows in place of the markup.

#### Scenario: A section renders as a heading by depth
- **WHEN** the caller renders a section with a nested child section
- **THEN** the outer title renders as a higher heading level than the inner title

#### Scenario: A metric renders as a labeled value
- **WHEN** the caller renders a metric block with a scalar value entry
- **THEN** the page shows the label and the scalar value together

#### Scenario: A table shows every resolved row through the grid
- **WHEN** the caller renders a table block whose value entry holds three rows
- **THEN** the payload holds the three rows, the grid shows them, and no sample note renders

#### Scenario: A figure renders from the supplied source
- **WHEN** the caller renders a figure block with a figure source string and a caption
- **THEN** the page holds an image with that source, and the caption below it

#### Scenario: An empty table keeps its card
- **WHEN** the caller renders a table block whose value entry holds zero rows and named columns
- **THEN** the card holds the title and the download link, and the payload holds the columns with no row

#### Scenario: An empty chart still renders its container
- **WHEN** the caller renders a chart block whose value entry holds zero rows
- **THEN** the page holds the chart container, and the inline option holds an empty data list

#### Scenario: An enumeration renders as a list

- **WHEN** the caller renders a text block with a lead sentence and six ordered items
- **THEN** the page holds the paragraph and an ordered list with the six items

#### Scenario: A list stands alone

- **WHEN** the caller renders a text block with an empty prose and three unordered items
- **THEN** the page holds the unordered list, and no empty paragraph

### Requirement: The number format of a resolved value
The renderer MUST format each numeric value that it shows, through one number helper and its closed set of kinds. The kinds are `scientific`, `compact`, `compact-scientific`, `identifier`, and `below-resolution`. The helper applies to the metric value and to each numeric table cell. The renderer picks the kind by magnitude and by column meaning, and no block carries a format field.

A zero in a column whose meaning is a p-value MUST NOT render as a bare `0`. In a table, the cell MUST render `<` the smallest positive value of the same column, rounded up to one significant digit. A stored zero means that the true value sits under the resolution of the estimator, and the smallest positive neighbor bounds that resolution from above. Thus the shown claim is always true. When the column holds no positive value, and on a metric, the form MUST be `≈0`. The raw stored cell MUST ride in the `title` attribute. A zero outside a p-value column keeps its `0`, because a zero count and a zero effect are real values. The bound reads in the notation of its column: plain from the scientific floor up, and exponential below it.

A negative shown form MUST print the typographic minus, and the raw stored cell keeps its own text. Thus a card and an axis title read one glyph.

The chart option rides as inline JSON, thus no function can format an axis tick. The derivation MUST bound an axis only where a static option field can state the bound. The count axis of a histogram holds whole ticks. Every other axis keeps the tick algorithm of the chart runtime.

When the shown form hides digits, the element MUST carry the full digits in its `title` attribute. When the shown form hides no digit, the element carries no `title` attribute. The helper MUST be deterministic: it reads no locale, thus the same value gives the same text on every host.

The kind resolution MUST read a declared column meaning first, and the name guess is the fallback for an undeclared column. A declared meaning replaces the name test alone, and the magnitude arms stay. Thus a declared column renders byte-identically to a name-matched column of the same nature.

#### Scenario: A p-value renders in the scientific kind
- **WHEN** the caller renders a metric whose value resolves to `0.0000427777663038`
- **THEN** the card shows a scientific form such as `4.3e-5`, and the `title` attribute holds the full digits

#### Scenario: A long float renders with few significant digits
- **WHEN** the caller renders a table cell that holds `-3.089028528355109`
- **THEN** the cell shows a short form with the typographic minus, and the `title` attribute holds the full digits

#### Scenario: A negative card reads the minus glyph
- **WHEN** the caller renders a metric whose value resolves to a negative number
- **THEN** the shown form carries the typographic minus, and the raw text stays in the `title` attribute

#### Scenario: A count renders in the compact kind
- **WHEN** the caller renders a value that is a large integer count such as `14201`
- **THEN** the text shows the grouped form `14,201`, and the `title` attribute holds the full digits only when the shown form hides a digit

#### Scenario: A short value carries no tooltip
- **WHEN** the caller renders a value whose full form already shows every digit, such as `42`
- **THEN** the text shows `42`, and the element carries no `title` attribute

#### Scenario: A non-numeric cell passes through
- **WHEN** the caller renders a table cell that holds the text `up`
- **THEN** the cell shows `up` unchanged

#### Scenario: A count axis holds whole ticks
- **WHEN** the caller derives a histogram option
- **THEN** the count axis carries a whole-tick bound, thus no count tick shows a fraction

#### Scenario: A declared meaning beats the name guess
- **WHEN** the caller renders a small numeric cell of a column declared `p-value`, whose name matches no token
- **THEN** the cell renders in the scientific kind, and the `title` attribute holds the full digits

#### Scenario: The magnitude arms survive a declaration
- **WHEN** the caller renders `0.536` in a column declared `p-value`
- **THEN** the cell shows `0.536`, exactly as a token-matched p-value column shows it

#### Scenario: A zero FDR renders as a data-derived bound
- **WHEN** the table view renders a `0` in an FDR column whose smallest positive value is `0.00036`
- **THEN** the cell shows `<4e-4`, and the `title` attribute holds the raw stored cell

#### Scenario: A zero with no positive neighbor renders as near-zero
- **WHEN** the table view renders a `0` in a p-value column whose other values are all zero
- **THEN** the cell shows `≈0`, and the `title` attribute holds the raw stored cell

#### Scenario: A zero count keeps its zero
- **WHEN** the table view renders a `0` in a column declared `count`
- **THEN** the cell shows `0`, exactly as before

### Requirement: A declared display label names the column

The table header MUST show the declared label of a column, with the raw column name in the `title` attribute of the header. An axis whose channel reads a labeled column MUST carry the label as its axis title. An axis whose channel applies a transform to a labeled column MUST carry the label inside the transform, for example `log10(Normalized count)`. A figure that applies its own transform keeps its semantic title, for example `−log10(p)` on a volcano. An undeclared header MUST prettify as the fallback: underscores become spaces, with the raw name on hover when the two differ. An undeclared value axis keeps the raw name. An undeclared category axis carries no title, because its category names state what it holds.

#### Scenario: The header shows the label with the raw name on hover

- **WHEN** the table view renders a column declared with a display label
- **THEN** the header shows the label, and the `title` attribute of the header holds the raw name

#### Scenario: The axis carries the label

- **WHEN** the chart derivation names an axis for a channel whose column carries a declared label
- **THEN** the axis title is the label, and the derivation stays deterministic

#### Scenario: A transformed axis carries the label inside the transform

- **WHEN** a box plots `y` with the `log10` transform over the column `normalized_count`, and the binding declares the label `Normalized count`
- **THEN** the y axis title is `log10(Normalized count)`, and a column with no label keeps the title `log10(normalized_count)`

#### Scenario: An undeclared header prettifies

- **WHEN** the table view renders the column `gene_symbol` with no declared label
- **THEN** the header shows `gene symbol`, and the `title` attribute of the header holds the raw name

#### Scenario: An undeclared category axis carries no title

- **WHEN** the chart derivation draws a category axis over a column with no declared label
- **THEN** the axis carries no title, and the value axis of the chart keeps the raw name of its column

### Requirement: The table grid
The page MUST render each table block through the pinned grid bundle, booted by the page script from the registered data of the block. The bundle joins the asset manifest, and the page references it as a classic script. The client-side row model virtualizes the DOM, thus the page holds the visible slice alone.

The payload MUST carry a display member: the resolved header label of each column, the resolved number kind, and the below-resolution bound where one exists. The server resolves, and the page formats over the shipped kinds. A shared test vector MUST pin the client formatter against the server helper.

The grid theme MUST build from the design tokens, thus the grid reads as the page does. The per-column filters and the header sort are the one filter surface, and no separate filter input renders. The full raw value of a formatted cell rides the cell tooltip, exactly as the `title` attribute carried it.

The card footer MUST state the shown count against the pre-bound total, in the form `N of M rows`, with the bound note beside it. The renderer MUST trim a percent-delimited display name to its first segment, with the full text on the cell tooltip. The print form MUST take the grid's print layout, up to a stated print cap. A larger table prints its first rows, and a printed line names the truncation and the download. A grid mount whose payload the registry does not hold keeps the header card and the download link, and the boot skips it.

#### Scenario: The grid renders the bounded table
- **WHEN** the page loads with a table block of 14,201 registered rows
- **THEN** the grid shows the rows with sort and per-column filters, and the DOM holds the visible slice alone

#### Scenario: The footer states the total
- **WHEN** the page renders a table bound to the top 10 rows of a 14,201-row artifact
- **THEN** the card footer reads `10 of 14,201 rows`, with the bound note beside it

#### Scenario: The client formats as the server does
- **WHEN** the shared vector runs through the server helper and the client formatter
- **THEN** the two give identical text for every entry

#### Scenario: No filter row renders
- **WHEN** the page renders any table block
- **THEN** no standalone filter input sits above the grid, and the column filters serve

#### Scenario: The print shows the bounded rows
- **WHEN** the page prints a table block at or under the print cap
- **THEN** the print form holds every row, and no scroll viewport clips one

#### Scenario: A giant table prints with a stated truncation
- **WHEN** the page prints a table block over the print cap
- **THEN** the print holds the first rows, and a printed line names the truncation and the download

#### Scenario: A missing payload keeps the card honest
- **WHEN** a grid mount finds no registered data under its block id
- **THEN** the header card and the download link stay, and the page throws nothing

### Requirement: The page navigation
The page MUST hold a left-side navigation with one anchor for each top-level section. Each anchor MUST target its section by the section block id.

The page script MUST highlight the anchor of the section in view, through an observer over the section anchors and with no dependency. Exactly one anchor is active on a page with sections, at every scroll position. A browser without the observer keeps the plain links, because the highlight is decoration.

#### Scenario: The navigation lists the top-level sections
- **WHEN** the caller renders a document with three top-level sections
- **THEN** the navigation holds three anchors, and each anchor targets its section id

#### Scenario: The page carries the scrollspy script
- **WHEN** the caller renders a document with sections
- **THEN** the page script observes the section anchors, and it drives one active class on the matching link

### Requirement: Escaping is always on
The renderer MUST escape every interpolated string through the markup runtime, which escapes each child and each attribute value by default. A raw insertion of serialized document data MUST occur only at a JSON script sink. Each serialized JSON MUST replace every `<` with `\u003c` before the insertion. A raw insertion is otherwise legal only for a trusted page constant, and for sibling markup that the runtime escaped already. Markup inside agent prose MUST reach the page as text, and never as an element.

#### Scenario: Hostile prose stays text
- **WHEN** the caller renders a text block whose prose holds a script tag
- **THEN** the page shows the tag as escaped text, and the page holds no script element from the prose

#### Scenario: A raw sink stays hardened
- **WHEN** the caller renders a chart whose data holds a `</script>` sequence in a cell
- **THEN** the inline JSON holds the replaced form, and the script element does not close early

### Requirement: The chart option derives, and the layout discipline applies
The renderer MUST derive the ECharts option object from the chart type, the encoding, and the resolved rows. The derived option MUST pass through `normalizeEchartSpec` before it inlines. The container id MUST derive from the block id.

The derived option MUST carry no toolbox. The derivation removes the toolbox that the layout discipline injects, and each other rule of the discipline stays. The chart card adds the toolbox of the page to the option of the page, as the toolbox requirement states.

#### Scenario: A bar chart derives its axes from the encoding
- **WHEN** the caller renders a bar chart with `x` and `y` in the encoding and resolved rows
- **THEN** the inline option holds the category axis from `x` and the values from `y`

#### Scenario: The normalize discipline applies
- **WHEN** the caller renders a chart block
- **THEN** the inline option carries the normalized layout, and it carries no in-spec title

#### Scenario: The report chart carries no toolbox
- **WHEN** the caller derives a chart block
- **THEN** the derived option holds no toolbox member, and the legend and the axis rules of the discipline stay

### Requirement: The composition derivation
The renderer MUST derive one option from a chart composition: one runtime series for each declared series, over the resolved rows of the one bound table. A transform applies per row, and `rank` ranks the column deterministically with shared ranks on ties. The label column rides each data item, and a static template formatter shows the name with the values. A reference line and a reference band derive as static mark members. Point labels show on the declared top-N subset alone. The label flags MUST survive a series split: when a group channel or a preset classification splits the rows, each flagged row carries its label in the series that holds it. An axis title replaces the raw column name where the author gives one, and a `log` scale maps onto the static axis type.

A dense figure module MUST build its points through the composition, with the semantic axis titles of its preset and its per-row classification. No preset expands into a composition in place of its module. The `volcano` module MUST classify each row against its thresholds, per row and with no aggregate. It emits three series: the two signal categories on the palette, and the null category on the muted chart color by construction. The classification and the guide lines MUST read one threshold pair, thus the color split always lands on the lines. Declared thresholds on the block replace the preset constants, and the defaults stay as they are.

A plotted channel MUST give each coordinate as a number where its column holds magnitudes. A table that arrives as text gives each cell as a string. Thus the `x`, `y`, and `y0` channels read the number of each cell where each cell of the column parses as a number. A column that declares the meaning of a category or of an identifier keeps its cells. The page reads the same numbers from the payload, because the data source marks each such column. A column that holds a name keeps its cells, for example the cluster `01`.

A dense scatter takes its symbol from a ladder. Over the hover threshold, the series takes the larger hit symbol, thus a point stays hoverable. Over the crowd threshold, the series takes a small symbol with reduced opacity instead. Per-point hover is lost in a crowd, thus shape legibility wins there. The derivation MUST stay deterministic, and it MUST compute no aggregate.

Two authoring faults MUST refuse as render problems. A band whose lower bound sits above its upper bound refuses, and the problem names the block. A quick-path transform whose derived name collides with a real table column refuses, and the problem names the collision.

#### Scenario: A text table plots numbers
- **WHEN** the caller derives a `volcano` over a table whose cells are all strings
- **THEN** each point of the option holds two numbers, and the page builds the same numbers from the payload

#### Scenario: A volcano derives from the preset
- **WHEN** the caller renders a `volcano` chart over an effect column and a p column
- **THEN** the option holds a scatter over the effect and the transformed p, with the declared guide lines

#### Scenario: A volcano colors its three categories
- **WHEN** the caller derives a `volcano` with no group channel
- **THEN** the option holds three series, the null series carries the muted color, and the split lands at the guide values

#### Scenario: A declared threshold moves the guide and the split together
- **WHEN** the block declares a significance threshold beside the `volcano` type
- **THEN** the guide line and the classification read that value, and the colors land on the line

#### Scenario: A grouped scatter keeps its point labels
- **WHEN** a composition holds point labels for a top-N subset and a group channel splits the rows
- **THEN** each flagged row carries its label in its own series, and the label count equals the declared count

#### Scenario: The tooltip names the point
- **WHEN** the caller renders a scatter with a label column
- **THEN** each data item carries the label as its name, and the option holds a static template formatter

#### Scenario: A rank transform is deterministic
- **WHEN** the caller derives one composition over the same rows two times
- **THEN** the two options are byte-identical, and a tied value shares its rank

#### Scenario: An area band derives from two columns
- **WHEN** a composition holds an `area` series with `y` and `y0` columns
- **THEN** the option holds the per-row band between the two columns

#### Scenario: The annotations are static members
- **WHEN** a composition holds a reference line and point labels for a top-N subset
- **THEN** the option holds static mark data and per-item label flags, and no function rides the option

#### Scenario: A dense scatter stays hoverable
- **WHEN** the caller derives a scatter over the hover threshold and under the crowd threshold
- **THEN** the series carries the larger hit symbol

#### Scenario: A crowded scatter recedes
- **WHEN** the caller derives a scatter over the crowd threshold
- **THEN** the series carries the small symbol with reduced opacity, and no larger hit symbol

### Requirement: The per-type derivation rules
The renderer MUST hold one fixed derivation rule for each chart type. A chart whose encoding lacks a column that its type demands MUST give a `RenderProblem`. A pie reads no `x` and no `y`. Thus the problem of a pie with no `group` or no `value` states that `group` names the slices and `value` sizes them. The renderer MUST compute no aggregate outside the named summaries, and a pie or heatmap entry with a repeated category MUST give a `RenderProblem`. Category order and group order MUST follow the first appearance in the rows, unless a channel carries an `orderBy`.

The named summaries are four. The histogram MUST bin with the auto rule: the larger of the Sturges count and the Freedman-Diaconis count. The box MUST compute type-7 quantiles with Tukey fences at 1.5 IQR. The violin MUST compute a Gaussian kernel density with the Silverman bandwidth, on a fixed grid of 64 points over the range of the category. The bandwidth reads the sample standard deviation and the type-7 quartiles, and it falls to the standard deviation alone when the IQR is zero. A category with fewer than five values, or with a bandwidth of zero, draws no violin, and it draws its median line. Each violin carries its median and its quartiles as an inner mark, from the same type-7 quantiles. The normalized bar MUST compute the share of each part in the total of its category. A category whose total is zero draws no bar, and a negative part refuses with its row.

A `box` and a `violin` MUST draw each value as one point over the shape when each slot holds 200 values or fewer. A slot is one category, or one category and one group. When one slot holds more than 200 values, no slot draws points. Thus one chart shows the points on each slot or on none.

With no `group` channel, the points spread across the band of their category through the axis jitter of the chart runtime. A point moves to the side only where it overlaps an earlier point, thus each point keeps its value. The axis jitter centers each point on its category and not on the slot of its group. Thus a grouped chart places each point on a hidden value axis over the category bands, inside the slot of its group. The points of one slot spread over 70% of the slot width in a fixed sequence, and they take the color of their group.

A slot of fewer than five values holds no box, and a slot with no density holds no violin. Such a slot MUST draw its median as a short line across the middle of its slot. Its points show each value where the chart draws points. Thus a chart of three or four replicates for each group is never empty. The median is the type-7 median, one of the named summaries.

A box category with points draws no separate outlier mark, because its points show each value. The outliers of a box with no group take the ink of the points.

The `stacked-bar`, the `normalized-bar`, and the `radar` MUST demand a `group` channel, because each one draws the parts of a category. The `stacked-bar` MUST stack the groups of one category, in group order. The `normalized-bar` MUST stack the shares, and its value axis runs from zero to one. The `radar` MUST draw one polygon for each group over the categories of `x` as the indicators. The indicator bound is the largest `y` value of the table, and a radar whose table holds no positive `y` value refuses. Each of the four new types keeps its data inline, whatever the size of the option. A chart of a new type with zero rows keeps its container, as every other chart does. A stacked form, a radar, a violin, and a heatmap each lay out one slot for each category and group pair. Such a chart MUST refuse when the slot count passes the slot bound of the design source, and the problem names the count.

A chart with an auxiliary series (an interval, an outline, or a facet panel) MUST state the legend entries from the names of the drawn series. Thus no auxiliary series shows an orphan legend entry.

#### Scenario: The histogram bins deterministically
- **WHEN** the caller renders a histogram over the same rows two times
- **THEN** the two pages hold the same bin edges, and the bin count follows the auto rule

#### Scenario: The box computes the summary
- **WHEN** the caller renders a box chart over a category with seven numeric values
- **THEN** the inline option holds the type-7 five-number summary, and one point series draws each value, the outlier included

#### Scenario: A large box category pairs its outliers
- **WHEN** the caller renders a box chart over a category with 202 numeric values and one outlier
- **THEN** the category draws no points, and its outlier sits in a paired scatter series in the ink

#### Scenario: Each small category draws its points
- **WHEN** the caller renders a violin over a category of 15 values and a category of 200 values
- **THEN** one point series draws the 215 values, and the category axis states the jitter with no overlap

#### Scenario: One large category removes the points of each category
- **WHEN** the caller renders a violin over a category of 15 values and a category of 201 values
- **THEN** the option holds no point series, and the category axis states no jitter

#### Scenario: A grouped distribution draws its points in the slot of each group
- **WHEN** the caller renders a box with a `group` channel of two conditions, and each slot holds 3 or 4 values
- **THEN** each group draws its points on the hidden slot axis inside its own slot, and the category axis states no jitter

#### Scenario: A thin slot draws its median
- **WHEN** a slot of a box or a violin holds four values
- **THEN** the slot draws no shape, and a short line in the color of its group marks the median of the four values

#### Scenario: A thin slot keeps its median where the points stop
- **WHEN** a violin holds a category of 3 values and a category of 201 values
- **THEN** the option holds no point, and the category of 3 values draws its median line

#### Scenario: A pie with an x column and no group refuses
- **WHEN** the caller renders a pie with the channels `x` and `value`
- **THEN** the render returns a `RenderProblem` that states that a pie reads no `x`, and that it names its slices with the `group` column

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
- **THEN** the option holds no outline and no inner mark for that category, the category draws its median line alone, and the other categories draw

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

### Requirement: The table data rides a data-script asset
The renderer MUST emit the bound table of each table block as a columnar data-script payload: a columns list, row arrays, and a dictionary for a string that occurs more than one time. The payload registers under one global map, keyed by the block id, and a classic `script` tag references the asset. The payload MUST carry the pre-bound row total of the artifact beside its rows. The table markup holds the header and no data rows. The renderer MUST return the payloads beside the page string, because the renderer writes no file. The payload derivation MUST be deterministic, thus two renders of one document give byte-identical payloads.

A chart whose derived option would exceed the inline bound MUST read its rows from a registered payload, under the same global map. A chart and a table over one artifact MUST share one payload. The page script builds the series from the columns, and the label rides as a column index, not a per-point copy. A chart under the inline bound keeps its inline option, exactly as before.

The payload rule reaches a chart whose every series draws one point for one row. A series that holds a value which no cell of the table gives keeps its rows inline, whatever the size of the option. A binned count, a five-number summary, an addressed pair, and the upper half of a band are each such a value. No descriptor can state one.

A figure can add series after the output of its composition, for example the band of a QQ figure. The composition series then read the payload, and each added series keeps its rows inline. The names of the leading series MUST match the composition output. Else the whole chart keeps its rows inline.

A split of a preset classification MUST reach the page as plain data. The volcano rule holds its two cuts. The MA rule holds the name of the `p` column and its threshold. The page reads the rule and puts each row in the category that the server gives it. A payload that does not hold the `p` column keeps the MA chart inline.

The asset name MUST carry the content hash of the payload, in the content-address style of a staged figure. The table card MUST link the raw pinned bytes of its artifact as the reader download, through a relative link.

A data asset past a compression threshold near 10 MB is a later arm, and today every payload stages plain.

#### Scenario: The page holds no data rows
- **WHEN** the caller renders a document with a table of 14,201 resolved rows
- **THEN** the markup holds the table header and zero data rows, and the payload holds the rows

#### Scenario: A dense chart ships no inline rows
- **WHEN** the caller renders a chart whose option would exceed the inline bound
- **THEN** the inline option holds no per-row data, and the chart reads the registered payload

#### Scenario: A binned chart keeps its rows
- **WHEN** the caller renders a histogram whose option exceeds the inline bound
- **THEN** the option carries its bins inline, because no descriptor states a binned count

#### Scenario: An added series keeps its rows inline
- **WHEN** the caller renders a dense QQ figure with a band
- **THEN** the points read the payload, and the two band series carry their rows in the page option

#### Scenario: The page splits an MA plot by the p column
- **WHEN** the caller renders a dense MA figure
- **THEN** the data source carries the MA rule, and the page builds the same two series as the inline option

#### Scenario: One artifact feeds one payload
- **WHEN** a table block and a chart block bind one artifact with one bound
- **THEN** the page holds one payload for it, and both blocks read it

#### Scenario: A small chart stays inline
- **WHEN** the caller renders a chart under the inline bound
- **THEN** the option carries its data inline, byte-identical to the form before this rule

#### Scenario: The payload is deterministic
- **WHEN** the caller renders one document two times
- **THEN** the two payload sets are byte-identical, and the asset names match

#### Scenario: The dictionary compresses a repeated string
- **WHEN** a column holds one category value across many rows
- **THEN** the payload stores the value one time in the dictionary, and each row holds its index

#### Scenario: The card links the download
- **WHEN** the caller renders a table block
- **THEN** the card holds a relative download link to the staged raw bytes of the artifact

### Requirement: The horizontal bar renders with the category on y

A horizontal bar MUST render the category axis on y and the value axis on x. The category axis MUST keep every label, because the long names are the reason the orientation exists. An annotation names a rendered axis, thus a zero line on the horizontal value axis is an `x` reference line. The axis titles, the declared labels, and the number rules bind to the axes wherever they render. A composition that mixes a horizontal bar with another series on one grid MUST refuse as a render problem.

#### Scenario: The NES chart renders horizontal with a zero line

- **WHEN** the caller derives a horizontal bar over a set-name column and an NES column, with an `x` reference line at zero
- **THEN** the category axis sits on y with every label, and the zero line stands on the value axis

#### Scenario: A vertical bar stays as it is

- **WHEN** the caller derives a bar with no orientation
- **THEN** the option is byte-identical to the option before the orientation existed

#### Scenario: A mixed grid refuses

- **WHEN** a composition holds a horizontal bar series and a scatter series
- **THEN** the derivation refuses with a problem that names the mix

#### Scenario: An orientation on a non-bar refuses

- **WHEN** the author states an orientation beside the `line` chart type
- **THEN** the render refuses with a problem that names the fault

### Requirement: The chart text reads for a reader
A preset MUST fill its semantic axis titles. A volcano titles "log2 fold change" and "−log10(p)". A manhattan titles "Chromosome" and "−log10(p)". A qq titles "Expected −log10(p)" and "Observed −log10(p)". The precedence, most specific first: an agent axes title, a declared column label, the preset title, then the raw or derived name. A category axis takes no raw or derived name, as the rules of a publication figure state.

The null category of a preset classification MUST take the muted chart color of the design source by construction. An agent-derived category whose value reads as the null token — `ns`, `n.s.`, or `not significant`, case-insensitive — MUST take the muted color too. Thus the significant categories carry the color, and the null category recedes.

The label of a guide line MUST sit inside the plot at the far end of the line. A vertical line ends at the top of the plot, and a horizontal line ends at the right edge. Thus no guide label covers a tick label. A guide line with no label text shows no label. A vertical reference band labels at the inside bottom edge of the band.

A category series name MUST prettify at derivation: underscores become spaces, deterministically. The tooltip reads the same name, and the raw value stays in the data rows.

#### Scenario: The volcano titles its axes
- **WHEN** the caller derives a `volcano` chart with no axes override and no declared label
- **THEN** the x axis reads `log2 fold change`, and the y axis reads `−log10(p)`

#### Scenario: A declared label beats the preset title
- **WHEN** the binding declares a label for the effect column of a `volcano`
- **THEN** the x axis reads the declared label

#### Scenario: The null category recedes
- **WHEN** a chart groups by a column whose values hold `Not significant`
- **THEN** that series carries the muted chart color, and the other series keep the palette

#### Scenario: A vertical guide labels at the axis
- **WHEN** the caller derives a chart with a vertical reference line that carries a label
- **THEN** the label sits inside the plot at the top end of the line, and no tick label sits under it

#### Scenario: The legend reads words
- **WHEN** a chart groups by a column whose value is `up_in_nonresponders`
- **THEN** the series name reads `up in nonresponders`, and the data rows keep the raw value

### Requirement: One reference ladder numbers every marker
A claim MUST render its prose with evidence markers. Every reference marker on the page MUST number in one bracket ladder, artifacts and citations alike, by first appearance. The identity rules stay: an artifact reference is identical under its stable serialization, and a citation is identical under its citation key. Thus one artifact takes one number, one paper takes one number, and an identical reference appears one time in the list.

The references MUST list at the end of the page in one appendix, titled "References", flat and in number order. Each entry carries a kind tag, thus the two shapes stay scannable. An artifact entry names the path in its entry form, with the locator where one exists. A derivation reference lists as its operation with its two pinned inputs, each named by path and locator. A literature entry carries the short citation, the description when the record carries one, and the key. The superscript notation retires. No auto-generated surface is titled "Data provenance", and none is titled "Literature".

#### Scenario: Two claims share one reference
- **WHEN** the caller renders two claim blocks that carry the same reference
- **THEN** both claims show the same bracket number, and the list holds one entry for it

#### Scenario: One paper takes one number
- **WHEN** a claim binding and a citation block name one `pmid:` key with different display text
- **THEN** both markers carry one number, and the appendix holds one entry for the key

#### Scenario: One appendix holds both kinds
- **WHEN** the caller renders a document with an artifact reference and a citation
- **THEN** one list titled "References" holds both entries, each with its kind tag, in number order

#### Scenario: The text carries one notation
- **WHEN** the caller renders a document with both reference kinds
- **THEN** every marker is a bracket number, and no superscript marker renders

### Requirement: Every evidentiary binding joins the References appendix
The binding of each evidentiary block MUST join the ladder: the metric value, the table, the chart, and the figure beside the claim and the citation. The card shows the marker, and the appendix entry names the path in its entry form.

A chart MUST also mark its track and each of its statistics. The title line of the chart carries one marker for each reference, in block order: the binding, the track, then each statistic. The appendix lists each one, and a statistic lists with its path and its locator.

The appendix entry of a derived path MUST add the chain of its record: each source path with its hash prefix, and the script hash prefix. The chain MUST link the staged script asset of the record, and it MUST link the derived output file. Thus the chain walks offline, from the chart to the sources and the script that made the table. The derivation records ride the render call, exactly as the citation records do, and the renderer stays pure.

#### Scenario: A bound table gains its appendix entry
- **WHEN** the caller renders a table block over a pinned artifact
- **THEN** the card carries a marker, and the appendix names the path

#### Scenario: A chart marks its track and its statistics
- **WHEN** the caller renders a chart with a track and two statistics
- **THEN** the title line carries four markers in block order, and the appendix holds four entries

#### Scenario: A derived chart states its chain
- **WHEN** the caller renders a chart over a derived path whose record names two sources and a script
- **THEN** the appendix entry carries the two source paths with hash prefixes, and the script hash prefix

#### Scenario: The chain links the script and the output
- **WHEN** the caller renders a document whose binding names a derived path with a staged script asset
- **THEN** the chain entry links the script file and the derived output, as relative paths

#### Scenario: A document with no derivation renders as before
- **WHEN** the caller renders a document whose bindings name no derived path
- **THEN** no chain line renders, and the appendix holds the plain entries

### Requirement: The citation card is a bibliography entry
The citation card MUST render the short citation of its pinned record, the note of the block, and the citation key. A `pmid:` key MUST also render a PubMed link, built deterministically from the id. The link is a navigation and it loads nothing, thus the stand-alone rule holds. A key with no pinned record renders the key and the note alone, because absence is a normal condition. The marker of the card joins the one reference ladder, and the entry of the key joins the References appendix.

#### Scenario: The card renders the bibliography
- **WHEN** a citation block binds `pmid:26997480` and the pinned record carries `Hugo et al. 2016`
- **THEN** the card shows the bracket marker, the short citation, the note, and a PubMed link for the id

#### Scenario: A record-less key still renders
- **WHEN** a citation block binds a key that the record map does not hold
- **THEN** the card shows the bracket marker, the key, and the note, with no link

### Requirement: The page stands alone
The skeleton MUST inline the style rules. The page MUST reference each script and each font as a relative `assets/` path, and it MUST reference no CDN host. Each manifest static MUST stage under `assets/deps/`, and the page references it there. Thus the shipped libraries and fonts sit apart from the files that the report produced. The report-side files — the figures, the data scripts, the sidecars, and the derivation scripts — keep the `assets/` root with their content-addressed names. The renderer MUST export one asset manifest, and each entry MUST name the staged file and its package source. The caller MUST stage each manifest entry beside the page, in the same pipeline that stages the figures.

The front door of the package MUST re-export that manifest and its entry type. An embedder that stages the assets itself reads the manifest, and it binds the asset lookup that the preview tool accepts. The front door already carries the type of that lookup, thus the value it describes belongs beside it. A hand-kept copy of the entries in an embedder would ship a build that is short one file, with nothing to say so.

#### Scenario: The page loads no remote resource
- **WHEN** the caller renders any valid document
- **THEN** the page holds no `src` and no stylesheet `href` with an `http` or an `https` scheme. A navigation anchor is the one admitted remote reference

#### Scenario: The statics sit under deps
- **WHEN** the caller stages the manifest and the page assets
- **THEN** each library and each font sits under `assets/deps/`, and each report-side file sits at the `assets/` root

#### Scenario: The manifest and the page agree
- **WHEN** the caller renders any valid document
- **THEN** each `assets/` reference in the skeleton names one manifest entry

#### Scenario: The front door carries the manifest
- **WHEN** a consumer imports the package by its name
- **THEN** the asset manifest and its entry type resolve from that import

#### Scenario: A staged page opens with no network
- **WHEN** the caller stages the manifest and a browser opens the page offline
- **THEN** each script and each font loads from its staged path, and no request fails

### Requirement: The page validates as HTML and CSS
The rendered page of a valid document MUST pass an offline HTML validation with the recommended preset. A disabled rule MUST carry its reason in the test. The inline style rules MUST hold known properties with valid value syntax. The gate guards the attribute hole of the markup types, because an intrinsic element accepts an unknown attribute silently.

#### Scenario: The rendered page is valid HTML
- **WHEN** the caller renders a document with every block kind
- **THEN** an offline HTML validation of the page reports no error

#### Scenario: The inline styles are valid CSS
- **WHEN** the style rules of the page pass through the CSS validator
- **THEN** the validator reports no unknown property and no invalid value

### Requirement: Each grounded block carries its lineage keys in the DOM
Each grounded block MUST carry its block id and the pin of each artifact reference as data attributes on its rendered container. The pin is the `path` and the `hash` of the reference. The grounded kinds are claim, metric, table, chart, figure, and citation. A citation block carries its external record identity in place of a pin.

#### Scenario: A grounded block renders its keys
- **WHEN** the render emits a claim with one artifact reference
- **THEN** the container carries the block id, the path, and the hash as data attributes

#### Scenario: A citation block renders its identity
- **WHEN** the render emits a citation block
- **THEN** the container carries the block id and the external record identity

### Requirement: The lineage library is a page asset
The lineage view library MUST ride in the asset manifest, and the page loads it from the local `deps/` directory. The harness imports no API from the library. When the page has no document asset, the page emits no lineage script and no popover control.

#### Scenario: The library ships with the page
- **WHEN** the preview renders with a document asset
- **THEN** the library lands in `deps/`, and the page references it with a relative source

#### Scenario: No document, no popover
- **WHEN** the render runs with no document asset
- **THEN** the page holds no lineage script and no popover control

### Requirement: The lineage popover
The page MUST open one popover that shows the backward chain of a grounded block, from a clickable control beside the reference marker. The control is a stroke-drawn branch glyph, muted at rest and primary on hover, with an accessible label. At most one popover is open at one time. The chain comes from the loaded document only, with no network request.

The popover MUST render the chain from the edges of the walk, and it MUST NOT render the flat node set. The rail alternates the artifact, the command that made it, and the files that the command read. A producer row carries the script, the step, and the hash head. Each input file continues the rail with its own producer, and a raw input ends its branch with a distinct terminal form. A bookkeeping node MUST NOT render as a row. The other outputs of a command MUST collapse behind one count row.

A row carries a type tag, the path, and the hash head. The path MUST drop the shared run prefix, because every hop of one chain carries it, and the tail holds the meaning. The width of the popover obeys its longest row, up to a viewport cap. Thus a name renders whole in a normal window, and a cut is the exception. In a narrow window, a long tail truncates at its start, and an over-long name cuts in its middle. The extension stays visible in both forms, and the full path rides the hover. The body MUST scroll inside a capped height, and the popover MUST NOT overflow the page. The popover MUST NOT cover its own control: it opens below the control, and it flips above when the space below is short. A truncated chain and a pin with no node each show an explicit mark. The popover is hidden in print, and it obeys reduced motion. The markup passes the same validity gate as the page.

#### Scenario: A control opens the chain
- **WHEN** a reader clicks the lineage control of a grounded block
- **THEN** the popover opens beside the block, and it shows each hop back to the raw data

#### Scenario: One popover at a time
- **WHEN** a reader clicks a second lineage control while a popover is open
- **THEN** the first popover closes, and the second popover opens

#### Scenario: The rail excludes the off-chain files
- **WHEN** the producing command wrote twelve other files beside the pinned artifact
- **THEN** the rail shows the pinned artifact and one count row, and no off-chain file renders as a hop

#### Scenario: A deep chain scrolls inside the popover
- **WHEN** the chain is taller than the capped height
- **THEN** the body scrolls inside the popover, and the page does not grow

#### Scenario: The run prefix stays off the rows
- **WHEN** every hop of a chain sits under one run
- **THEN** the rows show the tails without the run prefix, and the hover shows the full path

#### Scenario: A normal window cuts nothing
- **WHEN** the window gives the popover its capped width
- **THEN** every row of the chain shows its whole name, with no ellipsis

#### Scenario: The extension survives a narrow window
- **WHEN** the window is too narrow for two sibling names that differ only in their extension
- **THEN** each row shows the start of the name and the extension, and the cut sits in the middle

#### Scenario: The popover clears its control
- **WHEN** a reader clicks a control low on the page
- **THEN** the popover opens above the control, and no part of it covers the control

#### Scenario: A pin with no node
- **WHEN** the document has no node for the pin of a block
- **THEN** the popover shows the pin as the last hop, with an explicit absence mark

#### Scenario: Print hides the popover
- **WHEN** the page prints
- **THEN** no popover and no lineage control appear in the printed output

### Requirement: The wide grammar derives
The renderer MUST derive each new channel as content, with no style field on the block. A row whose `color`, `size`, `low`, or `high` cell is not numeric drops, as a row with no `x` value drops. An `orderBy` key that is not numeric compares as text.

A `color` channel MUST derive a continuous visual map over the numeric column. A column whose values cross zero takes the diverging scale centered on zero, and every other column takes the sequential scale. The heatmap `value` reads the same zero-crossing rule. A `color` channel is legal on a scatter, a bar, an embedding, and a dot plot, and a refusal names each other form. A `size` channel MUST derive a second visual map over the symbol size, on a scatter, a forest, and a dot plot. A series with a `color` or a `size` channel takes no large-render path, because that path draws one fill. A `color` channel beside a `group` channel is a refusal, because one chart colors by one channel.

A `low` channel and a `high` channel MUST derive an interval around each plotted value, through the named `interval` renderer. The interval lies along the value axis: on a bar it is the value axis of the orientation, and on a scatter it is the axis that draws no category. On a grouped bar each interval sits over its own bar, at the band offset of its group. A row whose bound sits on the wrong side of its value is a refusal that names the row. The interval is legal on a bar and a scatter, and a refusal names each other form. The interval series carries no legend entry.

A `facet` channel MUST split the table into one panel for each category value, in first-appearance order. Each panel carries its own axis pair and one label, and the panels share one axis range on each axis. One panel takes the full width after the title band and the scale band. Two panels take half of that width each, and three or more lay out three to a row. The chart body grows 360 px of height for each row of panels after the first. A facet is legal on a scatter, a line, a bar, the two stacked forms, and an embedding. A facet with more than twelve panels is a refusal.

A facet on a `stacked-bar` or a `normalized-bar` MUST draw the panels of the stacked form, with the layout of a faceted composition. Each panel stacks the parts of its own rows. Thus two panels can hold one pair of a category and a group, and a pair that occurs two times in one panel refuses. Each panel lists every category and every group of the table in one order. Thus a group keeps its color and its place in the stack. The value axis of each panel reads one range: from 0 to 1 for the normalized bar, and the round range of the largest stacked total of any panel for the stacked bar.

An `orderBy` on a category channel MUST sort the categories in the declared direction. The sort key of a category is the value of the named column. That value MUST be one value across the rows of the category. A category whose rows hold two different keys refuses, and the refusal names the category. A tie between categories keeps the first-appearance order. The heatmap reads an order on `x` and on `y` alike.

A `focus` list MUST color each named category with the one focus color, and mute every other category. On a bar with no group the categories are the values of `x`. On a chart with a group channel the categories are the group values. A focus is legal on a bar and the two stacked forms, and on a grouped scatter, line, box, violin, and radar. A focus beside a `color` channel refuses, and a focus value that no category holds refuses.

Each bar item of a bar chart with twelve items or fewer, counted across the series, MUST carry a value label. The label text is the shown form of the number helper, as a static per-item string. The label of a negative bar sits under its end. The stacked forms carry no value label. A bar that carries an interval carries no value label, because the whisker stands where the label would stand.

A bar that derives through the composition MUST keep zero on its value axis, as the base bar rule does. Each bar series states a category gap of 20 percent, thus an interval sits over the center of its own bar.

A composition MUST refuse an `orderBy` on a series after the first, because the axes read the first series. A `line`, an `area`, or a `step` over an ordered category axis draws its points in the order of that axis. A composition whose series name two different `color` columns, or two different `size` columns, MUST refuse, because one chart colors by one channel. A focus on a grouped `area` or `step` series MUST refuse.

A `color` channel and a `size` channel MUST join the payload descriptor of a dense chart. Thus an embedding colored by expression reads the registered payload past the inline bound. A block with an interval or a facet takes no payload pass, and it keeps its rows inline.

A figure can ask the composition to draw the high colors on top. Each series then draws its points in the ascending order of the color, inline and on the page. The descriptor of each such series states the order, and the page twin of the series build sorts the points by the same rule.

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

#### Scenario: A composition splits by condition
- **WHEN** the caller derives a `normalized-bar` of the cell types of each donor with a `facet` channel on the condition
- **THEN** the option holds one panel for each condition, and each panel stacks the shares of its own rows
- **AND** each value axis runs from 0 to 1

#### Scenario: A pair occurs two times in one panel
- **WHEN** a `stacked-bar` with a `facet` channel holds one donor and one cell type two times under one condition
- **THEN** the render returns a `RenderProblem` that names the pair

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

#### Scenario: The page keeps the order of the high colors
- **WHEN** the caller renders an embedding with a `color` channel whose option exceeds the inline bound
- **THEN** the descriptor states the color order, and the page builds the same items in the same order as the inline option

#### Scenario: A dense interval scatter stays inline
- **WHEN** the caller renders a scatter with `low` and `high` channels whose option exceeds the inline bound
- **THEN** the option keeps its rows inline, and each interval draws

### Requirement: The named renderers
A form that ECharts draws through a custom series MUST reach the page as a renderer name in the option, never as a function. The names are `interval`, `outline`, `cell-glyph`, and `stem`. Each item of such a series leads with its axis extent, and the series names those dimensions for the axis. A series that needs parameters beyond its items carries them as JSON in `itemPayload`.

The page script MUST register the function of each name with `echarts.registerCustomSeries` before the first chart initializes. The server export MUST register the same function in TypeScript before it draws. The option keeps each name as a string, and the chart runtime finds the function in its registry. One table lists each renderer, and each consumer registers each entry of that table.

A shared test vector MUST run the two twins over one set of items and compare the elements that they give. The same rule holds for the series builder of the payload path. One shared vector MUST run the page twin and the server twin over the transforms and the item forms, the four-member item included.

#### Scenario: The option carries a name, not a function
- **WHEN** the caller derives a violin
- **THEN** the custom series carries the string `outline` as its renderer, and the inline JSON holds no function

#### Scenario: The twins agree
- **WHEN** the shared vector runs through the page renderer and the server renderer
- **THEN** the two give identical element descriptions for every item

#### Scenario: The page registers each renderer
- **WHEN** the page bootstrap runs over a chart whose option names `outline` and `interval`
- **THEN** the bootstrap registers both names before the first chart initializes, and the set option keeps the two names

#### Scenario: The export draws through the registry
- **WHEN** the export renders an option whose custom series names the `interval` renderer
- **THEN** the SVG holds the interval, and no step replaces the name with a function

#### Scenario: The custom series feeds the axis
- **WHEN** the caller renders a bar with an interval whose `high` bound passes the largest bar
- **THEN** the value axis of the SVG covers the bound, and the cap sits inside the plot

### Requirement: The chart exports as a publication file
The renderer MUST make two SVG files for each chart block through the server-side render of the chart runtime: one at the single column of 89 × 67 mm, and one at the double column of 183 × 92 mm. Each SVG renders the option of the chart with its full rows, in the same theme, at the print text size. It holds no toolbox, no tooltip, and no animation. The root element states the size in millimeters, and the view box keeps the pixel space. The bytes MUST be deterministic: two renders of one document give byte-identical files, and the renderer renumbers each instance-scoped token of the chart runtime in order of appearance. The axis jitter of the chart runtime places a point at random where it finds no free place. Thus each export draws with one fixed seeded sequence in place of the random source, and two renders place each point at one place. Each SVG rides the render result as a staged data asset with a content-addressed name, and never as a page script. The caller stages it beside the page.

The export MUST carry a bound. A chart whose plotted point count passes the crowd row count gets no staged SVG. The page builds the hybrid SVG of such a chart, as the hybrid requirement states. The count reads the drawn coordinates: an empty slot counts nothing, a radar counts one coordinate for each indicator, and a violin outline counts each vertex that it draws.

The download menu of the chart card MUST hold an entry for each SVG and for each PNG. The page MUST make each PNG on click from an offscreen canvas of the chart runtime, with the same option and theme. The single column and the double column render at 300 DPI at the print text size. The 16:9 slide renders at 1920 × 1080 pixels at the slide text size.

A chart body taller than the default body of 400 px MUST grow the height of each column export in the same ratio. The column keeps its width. The height stops at 170 mm, the full page depth of the Nature guide. The root of the SVG and each PNG entry state the grown height. The slide keeps its 16:9 box.

The export MUST scale each text of the figure to the export text size. This includes the text of each child of a graphic group, for example the size legend. The panels of a facet end over the band of a bottom legend, and the band holds the legend lines that the export width gives. The x title of the facet sits on that band.

#### Scenario: A taller body grows the column height
- **WHEN** the caller renders a facet of two panel rows, with a body of 760 px
- **THEN** the single-column SVG states a height of 127 mm, and the single-column PNG entry states a height of 481 px

#### Scenario: The size legend prints at the export text size
- **WHEN** the export draws a dot plot with a size legend at the single column
- **THEN** the title and the values of the size legend read at 9.33 px

#### Scenario: A facet legend of three lines keeps its band
- **WHEN** the export draws a facet of two panels with a legend of eight cell types at the single column
- **THEN** the legend wraps into three lines, and the panels and the x title end over the band of those lines

#### Scenario: The SVG assets ride the render
- **WHEN** the caller renders a document with one chart block
- **THEN** the data assets hold two SVG entries for that block, and the page holds no script tag for them. The download menu links both by their relative paths

#### Scenario: The SVG is deterministic
- **WHEN** the caller renders one document two times, with a chart that holds a gradient and a clip path
- **THEN** the two SVG assets of each chart are byte-identical, and their names match

#### Scenario: A jittered chart exports the same bytes
- **WHEN** the caller exports a box whose categories each hold 200 tied values two times
- **THEN** the two SVG files are byte-identical

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
- **THEN** the data assets hold no SVG for it, and the SVG entries of the menu build the hybrid SVG on the page

#### Scenario: The page makes the PNG
- **WHEN** a reader clicks the single-column PNG entry
- **THEN** the page script draws the chart offscreen at 1050 pixels wide and downloads the PNG

#### Scenario: The slide PNG is 16:9
- **WHEN** a reader clicks the slide PNG entry
- **THEN** the page script draws the chart offscreen at 1920 × 1080 pixels and downloads the PNG

### Requirement: The rules of a publication figure
Each chart MUST obey the rules of a publication figure. One shared module holds each rule, and the shared chart path and each figure module read it. A figure module MUST NOT write an axis style of its own. The rules are these:

- The y title turns 90 degrees, and it sits in the middle beside its axis. The x title sits in the middle under its axis.
- A category axis shows a title only where the block declares one: an axes title, or the declared label of the column. A value axis always shows a title.
- A guide line is thin, gray, and dashed. Its label sits inside the plot at the far end of the line, thus it never covers a tick label.
- A guide line with no label text shows no label, because a bare constant beside a line reads as a plotted value.
- A continuous color scale shows its title and its two end values as static text, and it shows no drag control.
- The number helper formats each end of a color scale in the kind of its column, as a table cell does.
- A number in the scientific form prints as a power of ten with superscript digits inside the chart, for example `1.3 × 10⁻³`. This rule applies to these texts: the statistics text, the ends of a color scale, and the values of a size legend. It also applies to the p column of a forest and to the label of a p guide line. A table cell and a metric card keep the short form of the number helper, for example `1.3e-3`. A p-value zero keeps its below-resolution form.
- Eight categories or fewer take the Okabe-Ito palette. More categories take a fixed list of 24 distinct colors in a stable order, which opens with the Okabe-Ito set.
- A legend icon matches the form of its series: a line for a line and a step, a filled square for a bar and an area, and a circle for a point.
- The export text is 7 pt at the column width, which is 9.33 px at 96 px for each inch.
- Each category label of a facet panel prints. A label that does not fit its part of the panel width turns 45 degrees. A label that still covers its neighbor turns 90 degrees. The rule measures the page panel at a chart body 900 px wide.
- An axis title never covers a label of its axis. The chart runtime moves a title off its labels. A grid that holds its labels stops that move by default. Thus an option with such a grid states the move on each titled axis.

The shared module also gives a figure the statistics text, the size legend, and the axis builders. The statistics text prints one line for each statistic, in the form `label = value`, at the plot corner that the figure names. Where the reference of a statistic carries a `unit`, the unit follows the value. A percent sign joins the value, for example `27.5%`, and each other unit follows a space, for example `426 days`. The size legend draws three reference circles with their values, formatted by the number helper.

#### Scenario: The y title turns upright in the middle
- **WHEN** the caller derives a bar, a line, a scatter, a box, a violin, or a histogram
- **THEN** the y axis carries its title in the middle, turned 90 degrees

#### Scenario: A category axis shows no raw column name
- **WHEN** the caller derives a bar over a `cluster` column that declares no label
- **THEN** the category axis carries no title, and the value axis carries the title of its column

#### Scenario: A declared category title shows
- **WHEN** the binding declares the label `Cell type` for the category column
- **THEN** the category axis carries the title `Cell type`

#### Scenario: A guide label sits at the far end
- **WHEN** the caller derives a volcano with the default thresholds
- **THEN** each guide line is gray and dashed, and the p guide labels inside the plot at the right end

#### Scenario: An effect guide shows no bare constant
- **WHEN** the caller derives a volcano with the default thresholds
- **THEN** the two effect guides show no label, and no label covers a tick of the x axis

#### Scenario: The color scale prints its ends
- **WHEN** the caller derives a heatmap whose z-score runs from −2 to 2
- **THEN** the scale shows the title with the upper end `2`, the lower end `−2`, and no drag control

#### Scenario: A chart of nine groups takes the wide palette
- **WHEN** the caller derives a line chart with nine groups
- **THEN** the option states the list of 24 colors, and a chart of eight groups keeps the theme palette

#### Scenario: The legend icon matches the series form
- **WHEN** the caller derives a grouped line, a grouped scatter, and a grouped bar
- **THEN** the legend entries carry a line icon, a circle, and a filled square

#### Scenario: A small p-value prints as a power of ten in a chart
- **WHEN** a statistic of a p-value column resolves to `0.00131`, and a table cell of the same column holds the same value
- **THEN** the chart prints `1.3 × 10⁻³`, and the table cell prints `1.3e-3`

#### Scenario: A stored zero keeps the below-resolution form in a chart
- **WHEN** a statistic of a p-value column resolves to `0`
- **THEN** the chart prints `≈0`, and never a bare zero

#### Scenario: A statistic prints its unit
- **WHEN** the statistic `Median` binds a cell that holds 426, and its reference carries the unit `days`
- **THEN** the chart prints `Median = 426 days`

#### Scenario: Each facet label prints
- **WHEN** the caller derives a stacked bar with a facet of two panels over eight donors, and each donor name has twelve characters
- **THEN** each panel prints the eight names, turned 45 degrees, and no name hides

#### Scenario: A category title clears long labels
- **WHEN** the caller derives a horizontal bar over GO terms of 70 characters, and the binding declares the label `GO biological process`
- **THEN** the y axis states the move of its title, and the title in the SVG sits at the left of the longest term

#### Scenario: The export text is 7 pt
- **WHEN** the caller renders the SVG of a chart at the single column
- **THEN** the text of the SVG reads at 9.33 px, which is 7 pt at the column width

### Requirement: The figure registry
A chart type MUST derive through its figure module where one registers. The registry maps a chart type to its module, and the derivation asks the registry before every other path. A base type with no module MUST keep its fixed rule. A preset with no module MUST refuse, and the problem names the preset. This rule applies to each figure preset, and to the `volcano`, the `ma`, the `manhattan`, and the `km`. Each of these draws elements that no composition holds. The heatmap has no fixed rule beside its module, because no fixed rule draws its annotation strips. Thus a heatmap with no module refuses as a preset does.

A module MUST state the members of the block that it reads: the channels, the statistics, the track, the trees, and the focus. The derivation MUST refuse each other member before the module runs, and the problem names the member. A module is a pure function of the block, the rows, and its context, and its option holds no function.

The context MUST give the module the declarations of the bound table, the statistics, and the track. It MUST also give the tree of each axis and the page text size. Each statistic comes with its label, its value, and its shown text. The number helper formats the shown text in the kind of its locator column. The context MUST also give the composition machinery. Thus a dense figure reads the shared payload past the inline bound, as a composition does.

The page builds each series of the payload from the cells of the table. Thus a series that reads the payload MUST give on the page the items of the inline option. A module that changes the items of its composition output MUST keep those rows inline, because the page does not do the change.

A chart type with no module MUST refuse the members of the canonical figures: `shape`, `p`, `censor`, `risk`, `hit`, `metric`, `tracks`, the statistics, the track, and the trees. The refusal names the chart types that read the member. A composition MUST refuse the statistics, the track, and the trees, because it draws one grid over one table. A value entry that lacks a statistic, the track, or a tree that the block declares MUST give a `missing-value` problem.

The layout discipline and the figure rules MUST apply to the option of a module, as to each other chart.

#### Scenario: A registered preset takes its module
- **WHEN** a module registers for the `volcano` type
- **THEN** the derivation draws the option of the module, and the layout discipline applies to it

#### Scenario: An unregistered volcano refuses
- **WHEN** no module registers for the `volcano` type
- **THEN** the render returns a `RenderProblem` that states that the `volcano` figure is not available yet

#### Scenario: A figure preset with no module refuses
- **WHEN** the caller derives a `pca` chart and no module registers for it
- **THEN** the render returns a `RenderProblem` that states that the `pca` figure is not available yet

#### Scenario: A module refuses a member that it does not read
- **WHEN** a module reads `x` and `y`, and the block names a `group` channel
- **THEN** the render returns a `RenderProblem` that names the chart type and the `group` channel

#### Scenario: A channel of the canonical figures refuses on a base type
- **WHEN** the caller derives a line with a `shape` channel
- **THEN** the render returns a `RenderProblem` that names the `shape` channel, and the `pca` and `scatter` charts

#### Scenario: A statistic reaches the module with its shown text
- **WHEN** a module reads the statistics, and a statistic of a p-value column resolves to `0.00123`
- **THEN** the context gives the statistic with the label of the block and the shown text `1.2 × 10⁻³`

#### Scenario: The page builds the items of the inline option
- **WHEN** a gallery chart, or a copy of its table repeated past the inline bound, reads the payload
- **THEN** the page builds each described series with the items of the inline option

#### Scenario: A composition refuses the statistics
- **WHEN** a composition block carries one statistic
- **THEN** the render returns a `RenderProblem` that states that a composition reads no statistics

#### Scenario: A tree reaches the module with its columns
- **WHEN** a module reads the trees, and the block binds a tree on each axis
- **THEN** the context gives the rows of each tree with its parent, child, and height columns

#### Scenario: A tree refuses on a chart that draws none
- **WHEN** the caller derives a bar with a tree of `x`
- **THEN** the render returns a `RenderProblem` that names the tree and the `heatmap` chart

### Requirement: The GSEA running enrichment score figure
A `gsea` chart MUST draw the running enrichment score figure of the GSEA paper and of `gseaplot2`. The figure reads the `x` channel for the rank, the `y` channel for the running score, the `hit` channel, the `metric` channel, and the statistics. An optional `group` channel names the gene set of each row. Three stacked panels share one rank axis, and their heights keep the ratio 1.5 : 0.5 : 1.

- The top panel draws the running score of each set as a line in the color of the set.
- The top panel also draws a line at zero, and a dashed mark from zero to the maximum deviation of each set.
- The middle panel draws one thin tick at each hit of each set. Each set has one row in the color of the set.
- The bottom panel draws the ranked metric as a gray area, with a line at zero.
- The three panels share one left edge, one right edge, and one rank range: the smallest and the largest rank of the table.
- Only the bottom panel shows the tick labels and the title of the rank axis.
- The statistics print inside the top panel. They print at the top right when the first set peaks above zero, and at the bottom left when it dips under zero.
- The legend names each set, with one set on each line, under the rank axis. A figure of one set draws no legend.

The figure MUST refuse each of these faults, and the problem names the cause:

- a block with no `x`, `y`, `hit`, or `metric` channel
- a channel with a transform or an order
- a hit cell that is not 1 or 0
- two metric values at one rank, because the sets of one figure share one ranked list
- two rows of one set at one rank.

The figure computes these summaries from the rows of the bound table:

- The maximum deviation of each set: the first vertex of the largest absolute running score.
- The drawn vertices of each curve. A curve of 1000 vertices or fewer draws each vertex.

A longer curve keeps the first and the last vertex, and each vertex at a stride of `ceil(n / 1000)` places. It also keeps each turn of the curve, each vertex beside a crossing of zero, each hit, and the maximum deviation. The curve drops each other vertex. A running score falls in a straight line between two hits, thus the kept vertices hold each corner of the curve. The figure never drops a hit tick. Thus a figure of three sets over a ranked list of about ten thousand genes stays under the coordinate bound of the SVG export.

#### Scenario: Three panels share the rank axis
- **WHEN** the caller derives a `gsea` chart over the running scores of two sets
- **THEN** the option holds three grids with one left edge and the heights 1.5 : 0.5 : 1
- **AND** the three x axes share one rank range, and only the bottom axis shows its labels and its title

#### Scenario: The top panel draws the running score of each set
- **WHEN** the caller derives a `gsea` chart over two sets
- **THEN** the top panel holds one line for each set in the palette color, and a line at zero
- **AND** each set carries a dashed mark from zero to its maximum deviation

#### Scenario: The middle panel draws a tick at each hit
- **WHEN** a set holds ten rows with a hit of 1
- **THEN** the middle panel draws ten ticks in the row and the color of that set

#### Scenario: The bottom panel draws the metric as an area
- **WHEN** the caller derives a `gsea` chart
- **THEN** the bottom panel draws the ranked metric one time as a gray area, with a line at zero

#### Scenario: The statistics print inside the top panel
- **WHEN** the block binds the statistics `NES` and `FDR`, and the first set peaks above zero
- **THEN** the top right of the top panel prints `NES = 2.22` and `FDR = 1.6 × 10⁻³`

#### Scenario: A long ranked list thins its drawn vertices
- **WHEN** the caller derives a `gsea` chart of three sets over 9790 ranks
- **THEN** each line keeps each hit, each turn, and the maximum deviation of its set
- **AND** the middle panel keeps each hit tick, and the SVG export draws the figure

#### Scenario: A hit that is not 1 or 0 refuses
- **WHEN** a hit cell holds `True`
- **THEN** the render returns a `RenderProblem` that names the hit column, the value, and the rank

#### Scenario: Two metric values at one rank refuse
- **WHEN** two sets hold different metric values at one rank
- **THEN** the render returns a `RenderProblem` that states that the sets of one figure share one ranked list

### Requirement: The Kaplan-Meier figure
A `km` chart MUST draw the Kaplan-Meier figure of `survminer` and of the KMunicate study. The figure reads the `x` channel for the time, the `y` channel for the survival, and the statistics. It also reads the optional channels `group`, `low`, `high`, `censor`, and `risk`. The figure plots the survival of the table, and it fits no curve.

- Each group draws a step line in the color of the group. The line starts at 1 at time 0, and it holds its value until the next row.
- The band between `low` and `high` draws as a step band in the color of the group, under the line.
- Each row with a `censor` count above zero carries a thin upright tick on its curve.
- The number-at-risk table draws under the plot, with one row for each group. Each group name takes the color of its curve. The table prints one count at each tick of the time axis.
- A dashed gray line marks the survival 0.5 from time 0 to the largest median. A dashed drop line goes from 0.5 to the time axis at the median of each curve.
- The statistics print at the top right of the plot.
- The survival axis holds 0 to 1. The time axis starts at 0 and ends at the last time of the table.
- The tick step of the time axis is the smallest nice step at or over one fifth of the last time. Thus the span from 0 to the last time holds five steps at most. A nice step is 1, 2, 2.5, or 5 times a power of ten. For example, a last time of 1,022 days gives the step 250 and the ticks 0, 250, 500, 750, and 1,000.
- The legend names each group at the top of the chart. A figure of one curve draws no legend.

The figure MUST refuse each of these faults, and the problem names the cause:

- a block with no `x` channel or no `y` channel
- a channel with a transform or an order
- a survival under 0 or over 1, because the axis holds 0 to 1
- a bound on the wrong side of its survival.

The figure computes these summaries from the rows of one group:

- The number at risk at a tick: the `risk` value of the first row at or after the tick. Past the last row of the group, the count is 0.
- The median: the time of the first row whose survival is 0.5 or less. A curve that stays above 0.5 has no median and no drop line.

#### Scenario: Each group draws a step line from 1
- **WHEN** the caller derives a `km` chart whose first row of a group sits at time 5
- **THEN** the line of that group starts at time 0 at the survival 1, and it steps at each row

#### Scenario: The band draws as a step band
- **WHEN** the block names `low` and `high`
- **THEN** each group draws its band as two stacked step series in its color, and the band takes no legend entry of its own

#### Scenario: A censored row carries a tick
- **WHEN** a row holds a `censor` count of 3
- **THEN** a thin upright tick sits on the curve at the time and the survival of that row

#### Scenario: The risk table reads the counts at the axis ticks
- **WHEN** the time axis ticks at 0, 200, 400, 600, and 800, and the last row of a group sits at 765
- **THEN** the table row of that group prints the risk of the first row at or after each tick, and 0 at 800

#### Scenario: The median lines reach each curve that crosses 0.5
- **WHEN** one curve falls to 0.489 at time 426, and the other curve falls to 0.494 at time 270
- **THEN** a line at 0.5 runs from 0 to 426, and two drop lines sit at 270 and at 426

#### Scenario: The statistics print at the top right
- **WHEN** the block binds the statistic `Log-rank p` to a p-value cell that holds 0.00131
- **THEN** the top right of the plot prints `Log-rank p = 1.3 × 10⁻³`

#### Scenario: A survival outside 0 to 1 refuses
- **WHEN** a row holds the survival 100
- **THEN** the render returns a `RenderProblem` that names the row, the value, and the survival column

### Requirement: The forest figure
A `forest` chart MUST draw the forest figure of `forestplot` and of `forestploter`. The figure reads the `y` channel for the term and the `x` channel for the estimate. It also reads the optional channels `low`, `high`, `p`, and `size`.

- The rows read top-down in the order of the table. An `orderBy` on the `y` channel sorts them.
- The x axis is logarithmic when each estimate and each bound is above zero. Each end of the axis sits at a nice ratio: 1, 2, 2.5, 4, or 5 times a power of ten. The lower end is the largest nice ratio at or under the data and 1. The upper end is the smallest nice ratio at or over the data and 1.
- A table with a value at or under zero holds differences. Its x axis is linear.
- A thin solid gray line marks no effect: 1 on a log axis, and 0 on a linear axis.
- Each estimate draws as a dark square. The `size` channel sets the area of each square, thus the side grows with the square root of the value.
- The interval of each row draws as a line with a cap at each bound.
- A text column at the right prints each estimate with its interval, for example `0.53 (0.38–0.75)`. The title of the column is the title of the x axis.
- The estimate and its two bounds print with the same count of decimals. The count is 2 when each value that is not zero is 0.1 or more in magnitude. Else the count gives two significant digits to the smallest value of the row, for example `0.052 (0.012–0.230)`.
- A negative value prints the typographic minus. A negative bound joins the interval with the word `to`, for example `−0.40 (−0.90 to 0.10)`. A dash beside a minus reads as a range of the wrong sign.
- A second text column prints the `p` value through the number helper, as a power of ten, where the block names the channel. The `p` channel names a p-value column whatever its name, thus each cell takes the kind of a p-value. A stored zero prints the bound under the smallest positive value of the column, for example `<2 × 10⁻⁴`. A column with no positive value prints `≈0`.
- A term name breaks at its spaces into lines of 18 characters, and it holds 2 lines at most. A longer name ends with an ellipsis. The square of each row names the whole term in its tooltip.
- The term column draws no axis line and no tick. The chart holds the terms and the two text columns inside its edges, at the page width and at each export width. Each export scales the offset of a text column with its text size.

The figure MUST refuse each of these faults, and the problem names the cause:

- a block with no `x` channel or no `y` channel
- a transform on a channel, or an order on a channel other than `y`
- a term that holds two rows, because the two squares would share one line
- a bound on the wrong side of its estimate.

The figure computes one summary: the two nice ratios at the ends of the log axis.

#### Scenario: The rows read in table order
- **WHEN** the caller derives a `forest` chart over five Cox terms
- **THEN** the first term of the table sits at the top, and the y axis runs top-down

#### Scenario: The log axis ends at nice ratios
- **WHEN** the smallest bound is 0.376 and the largest bound is 3.05
- **THEN** the x axis is logarithmic from 0.25 to 4, with a solid gray line at 1

#### Scenario: The text columns print the estimate and the p value
- **WHEN** a row holds the estimate 0.5318, the bounds 0.3758 and 0.7526, and the p value 0.000364
- **THEN** the estimate column prints `0.53 (0.38–0.75)`, and the p column prints `3.6 × 10⁻⁴`

#### Scenario: The p column formats as a p-value whatever its name
- **WHEN** the `p` channel names the column `wald`, one row holds 0, and the smallest positive value of the column is 0.000109
- **THEN** the p column prints `<2 × 10⁻⁴` for the zero, and never a bare `0`

#### Scenario: A ratio near 1 prints two decimals
- **WHEN** a row holds the estimate 1.0153, and the bounds 0.9960 and 1.0349
- **THEN** the estimate column prints `1.02 (1.00–1.03)`

#### Scenario: A long term fits the single column
- **WHEN** the caller exports a `forest` chart with the term `Karnofsky score (physician)` at the single column
- **THEN** the term prints on two lines, and the terms, the estimate column, and the p column show whole inside the file

#### Scenario: The size channel sets the area of a square
- **WHEN** two rows hold the sizes 100 and 25
- **THEN** the side of the first square is two times the side of the second square

#### Scenario: A term of two rows refuses
- **WHEN** two rows name the term `Age (per year)`
- **THEN** the render returns a `RenderProblem` that names the term

### Requirement: The ROC figure
A `roc` chart MUST draw the ROC curve figure of `pROC`. The figure reads the `x` channel for the false positive rate and the `y` channel for the true positive rate. It also reads the optional `group` channel and the statistics.

- Each group draws its empirical curve in the color of the group. The curve runs through the points of the group in order of the false positive rate, then of the true positive rate. Thus the steps of the table read as steps, and a tie of scores reads as a diagonal segment.
- The figure adds no point that the table does not hold.
- A dashed gray diagonal from (0, 0) to (1, 1) marks chance.
- The two axes hold 0 to 1 with one tick step of 0.2.
- One unit on x equals one unit on y, by the layout of one unit. The legend sits in a band under the square, thus a narrow column keeps a large square.
- The statistics print at the bottom right of the plot, for example one AUC for each curve. The text is the label of a point at the corner (1, 0) of the data. Thus the text stays in the corner of the square in each container. The text breaks into lines inside the width of the square.
- A figure of one curve draws no legend.

The figure MUST refuse each of these faults, and the problem names the cause:

- a block with no `x` channel or no `y` channel
- a channel with a transform or an order
- a rate under 0 or over 1, because the axes hold 0 to 1.

The figure computes no summary.

#### Scenario: Each group draws its empirical curve
- **WHEN** a group holds the points (0, 0), (0.0154, 0.0168), and (0, 0.0084) in this order
- **THEN** the curve of that group runs through (0, 0), (0, 0.0084), and (0.0154, 0.0168)

#### Scenario: The diagonal marks chance
- **WHEN** the caller derives a `roc` chart
- **THEN** a dashed gray line runs from (0, 0) to (1, 1), and both axes hold 0 to 1

#### Scenario: One AUC prints for each curve
- **WHEN** the block binds one AUC statistic for each of two curves
- **THEN** the bottom right of the plot prints the two lines `AUC, ECOG + Karnofsky + age = 0.627` and `AUC, ECOG alone = 0.619`

#### Scenario: The ROC plot is a square
- **WHEN** the caller derives a `roc` chart of two curves
- **THEN** each media rule states a square grid, and the legend sits under the square

### Requirement: The oncoprint figure
An `oncoprint` chart MUST draw the alteration matrix of cBioPortal, ComplexHeatmap, and maftools. The figure reads the `x` channel for the sample and the `y` channel for the gene. It also reads the `value` channel for the alteration class, and the optional `tracks` channel.

- Each cell of one gene and one sample draws a gray ground through the `cell-glyph` renderer. An altered cell adds one glyph in the color of its class. The glyph has the width of the ground and a part of its height.
- Each common class of the MAF standard takes a fixed color. Seven classes take the Okabe-Ito colors, and `Multi_Hit` takes black. A class that the fixed map does not hold takes the next color of the wide palette that the map does not use.
- A bar over the matrix draws the alteration count of each sample, stacked by class. The bar shares the sample axis of the matrix.
- A bar at the right of the matrix draws the altered share of each gene, with its percent text at the end of the bar. The bar shares the gene axis of the matrix.
- The first gene sits at the top. The genes and the samples obey the `orderBy` of their channels, and otherwise the first appearance in the rows.
- The sample names hide, and the axis title states the sample count, for example `sample (n = 193)`.
- A row with an empty class names a sample with no alteration. That sample draws the ground alone, and it counts in the share of each gene.
- Each column of `tracks` draws one strip of cells under the matrix. Each cell takes the color of the value of its sample. The legend names each class, then each track value.
- Each gene name and each percent text prints on the page and in the double-column export. The default body holds a gene row of 16 px for a few genes alone. A figure of more genes states a taller chart body, and the grids keep their parts of it. The band under the matrix holds the legend lines of the single column.
- On a single journal column, a gene name that covers its neighbor hides, and the percent text of its row hides with it.

The figure computes these summaries from the rows of the bound table:

- The alteration count of a sample: the count of its rows with a class, for each class.
- The altered share of a gene: the count of samples with a class in that gene, divided by the count of all samples of the table.

The figure MUST refuse each of these faults, and the problem names the cause:

- a block with no `x`, `y`, or `value` channel
- a transform on a channel, or an order on the `value` channel
- two rows with a class for one gene and one sample. One cell draws one class, and the MAF standard states `Multi_Hit` for such a cell.
- a track column that holds two values for one sample
- a matrix of more cells than the slot bound of the design source. The count of cells is the count of genes times the count of samples, and the problem names the three counts.

#### Scenario: Each cell draws a glyph for its class
- **WHEN** the caller derives an `oncoprint` over three genes and four samples
- **THEN** the option holds one custom series that names the `cell-glyph` renderer, with twelve cells
- **AND** a cell with the class `Missense_Mutation` carries the place of its fixed color, and a cell with no class carries no glyph

#### Scenario: An unknown class takes a palette color
- **WHEN** a row holds the class `Silent`
- **THEN** the class takes a color of the wide palette that no common class uses

#### Scenario: The count bar stacks the classes of each sample
- **WHEN** a sample holds three altered genes, and a second sample holds none
- **THEN** the bar over the matrix stacks three alterations for the first sample and none for the second

#### Scenario: The share bar prints the percent over every sample
- **WHEN** two of four samples hold an alteration of `FLT3`, and one of the four samples holds no alteration
- **THEN** the bar of `FLT3` measures 0.5, and its text reads `50%`

#### Scenario: The orders sort the matrix
- **WHEN** the `y` channel carries `orderBy` on the gene rank, and the `x` channel carries `orderBy` on the sample rank
- **THEN** the genes read from the top down in rank order, and the samples read in rank order

#### Scenario: The sample names hide
- **WHEN** the caller derives an `oncoprint` over 193 samples
- **THEN** the sample axis shows no names, and its title reads `sample (n = 193)`

#### Scenario: A track draws a strip under the matrix
- **WHEN** the block names one track column that holds one value for each sample
- **THEN** a strip of cells in the value colors draws under the matrix, and the sample title moves under the strip
- **AND** the legend names each value

#### Scenario: Twenty genes take a taller body
- **WHEN** the caller derives an `oncoprint` of 20 genes
- **THEN** the render states a chart body taller than 400 px, and each gene row takes 16 px of it at least

#### Scenario: A matrix past the slot bound refuses
- **WHEN** the table names 101 genes and 1,000 samples
- **THEN** the render returns a `RenderProblem` that states 101 genes, 1000 samples, and 101000 cells

#### Scenario: Two classes in one cell refuse
- **WHEN** two rows name the gene `FLT3` and one sample with two classes
- **THEN** the render returns a `RenderProblem` that names the gene, the sample, and `Multi_Hit`

### Requirement: The lollipop figure
A `lollipop` chart MUST draw the mutation plot of maftools and of the cBioPortal mutation view. The figure reads the `x` channel for the amino-acid position and the `y` channel for the count. It also reads the optional `group` channel for the class, the optional `label` channel, and the optional track.

- Each row draws a stem from zero to its count and a head at the count, through the `stem` renderer. A row whose position or count is not a number draws nothing.
- The `group` channel sets the color of the head. A class of the MAF standard takes the color that the oncoprint gives it. The legend names each class with a circle.
- The stems draw from the largest count to the smallest. Thus a small head at one position draws over the stem of a large head.
- The count axis starts at zero, and its ticks are whole counts.
- The x axis spans from zero to the `length` column of the track. With no `length` column, or with no track, the axis ends at the largest domain end or the largest position.
- The track draws on a band under the axis: a gray backbone of the full protein, and one box for each domain row. A domain takes the first lane where it overlaps no earlier domain. Domains of one name share one color.
- Each box shows its name inside when the name fits. A box too narrow for the full name shows a short name that ends with `…`. A box too narrow for four characters shows no name. The room of a name is the part of the axis that its box spans, at a single journal column.
- The three largest counts show the text of the `label` column over their heads.

The figure computes no summary. Each stem is one row, and each box is one row of the track.

The figure MUST refuse each of these faults, and the problem names the cause:

- a block with no `x` or `y` channel
- a transform or an order on the `x`, `y`, or `group` channel
- a track table that does not hold the `start`, `end`, or `label` column.

#### Scenario: Each mutation draws a stem and a head
- **WHEN** the caller derives a `lollipop` over the mutations of DNMT3A, with the class as `group`
- **THEN** the option holds one custom series for each class that names the `stem` renderer, in the color of the class
- **AND** the stems of each class draw from the largest count to the smallest

#### Scenario: The track draws the domains under the axis
- **WHEN** the block binds a track of three domains, and two of them overlap
- **THEN** a band under the axis holds the backbone and one box for each domain, and the two overlapping domains sit in two lanes

#### Scenario: The axis spans the protein
- **WHEN** the track holds the length 912
- **THEN** each x axis spans from 0 to 912
- **AND** with no track, the axis ends at the largest position

#### Scenario: A narrow box shortens its name
- **WHEN** a domain named `Interaction with DNMT1 and DNMT3B` spans a fifth of the protein
- **THEN** the box shows a short name that ends with `…`, and a domain of seven residues shows no name

#### Scenario: The three largest counts carry their labels
- **WHEN** the rows hold the counts 19, 7, 2, and 1, with the `label` channel on the protein change
- **THEN** the texts `p.R882H`, `p.R882C`, and `p.R736H` show over their heads

#### Scenario: A track column outside the track table refuses
- **WHEN** the track names a `start` column that the track table does not hold
- **THEN** the render returns a `RenderProblem` that names the column

### Requirement: The volcano figure
A `volcano` chart MUST draw the volcano figure of DESeq2 papers and of EnhancedVolcano. The figure reads the `x` channel for the effect, the `y` channel for the p-value, the optional `label` channel, and the thresholds. The figure applies `neg_log10` to the p-value.

- The figure splits the rows into three categories at the thresholds: down, up, and not significant. The thresholds default to `0.05` and `1`. The guide lines read the same two values, thus the split lands on the lines.
- The null points draw under the signal points, in the muted gray and smaller. The down points take the blue of the palette, and the up points take its vermilion.
- The legend names each category with the count of its points, for example `Up (118)`.
- The ten most significant signal points that carry a name show the text of the `label` column. The derivation places each name, and a thin leader line joins the name to its point. A name tries the right side, the left side, and the top of its point, then one line further away at each step.
- A name MUST NOT cover another name, a leader line, or a point, and a leader line MUST NOT cross a name or a point. Where no place is free, the name takes the place that covers the fewest points and no name. A name that finds no place clear of the other names draws nothing.
- The derivation places the names one time for each render: the page and each export size. A render measures each place in its frame, that is, a plot size in pixels and the text size of the render. Each frame is a little smaller than the plot that the runtime draws at that size. Thus a name that is clear in the frame is clear in the drawn plot.
- The frames are these:
  - the page: 760 × 285 px at the 12 px text.
  - the 89 mm export: 260 × 160 px at the 9.33 px text.
  - the 183 mm export: 580 × 245 px at the 9.33 px text.
  - the slide: 1600 × 760 px at the 24 px text.
- The page draws the names of the page frame. The option also holds the names of each export size under the export width. The export option of the server and of the page takes the names of its width in place of the page names. Thus each SVG file and each PNG file print the names of their own size. No two names print on top of each other at any size.
- The page frame reads a window 1280 px wide. On a narrower window, the plot is smaller than its frame. Thus the runtime also hides a name that overlaps another name.
- The names ride one series after the points, and that series keeps its rows inline. Thus a dense volcano reads the payload, and the names draw over the points.
- The effect axis is symmetric around zero. Each end is the round number at or past the largest effect and the effect threshold.
- The p axis starts at zero.
- A row with no p-value draws no point, and it counts in no category.
- A stored p-value of 0 states that the true p sits under the resolution of the test, and `neg_log10` gives it no value. Such a row draws an upward triangle at the largest finite −log10 p of the table. Where no finite p passes the significance line, the triangle draws one unit over the line. The effect of the row selects its category, as for each other row. The row counts in that category, and it can show its name.
- The label of the p guide prints the threshold as a p-value column prints it, as a power of ten, for example `p 1 × 10⁻⁷`.

The figure computes these summaries from the rows:

- The count of each category: the count of the rows that the split puts in it.
- The labeled rows: the signal rows with a name, in the order of the p-value, at most ten. A stored zero comes first. A tie keeps the order of the rows.
- The place of each name in each frame: the first free place in the order of the sides and the steps, in the order of the labeled rows.

The figure MUST refuse a block with no `x` channel or no `y` channel, and a `group` channel. The problem names the channel.

#### Scenario: The null points draw under the signal points
- **WHEN** the caller derives a `volcano` over the pasilla table
- **THEN** the null series is gray, its points are smaller, and it draws under the down series and the up series

#### Scenario: The legend counts each category
- **WHEN** the table holds 107 down rows, 118 up rows, 8,541 null rows, and some rows with no p-value
- **THEN** the legend reads `Down (107)`, `Up (118)`, and `Not significant (8,541)`

#### Scenario: Ten signal points show their names
- **WHEN** the most significant signal row carries no name, and the eleventh signal row carries a name
- **THEN** the ten signal rows after the first show their names, and the null rows show none

#### Scenario: No name covers a name or a point
- **WHEN** the caller derives a `volcano` over the pasilla table
- **THEN** the box of each name overlaps no other box and holds no point, and each name carries a leader line to its point

#### Scenario: No name covers a name at any size
- **WHEN** the caller derives a `volcano` over the pasilla excerpt, and makes the export option of each export size
- **THEN** in the frame of the page and of each export size, the box of each name overlaps no other box
- **AND** the export option holds no member that is not a field of the chart runtime

#### Scenario: A narrow page hides an overlapped name
- **WHEN** the caller derives a `volcano`
- **THEN** the series of the point names tells the runtime to hide a name that overlaps another name

#### Scenario: A stored zero draws at the top as a triangle
- **WHEN** a gene with the effect −2.5 holds the stored p-value 0
- **THEN** an upward triangle in the down color draws at the largest finite −log10 p of the table
- **AND** the gene counts in the down category, and it shows its name first

#### Scenario: The p guide prints a power of ten
- **WHEN** the block declares the significance threshold 1e-7
- **THEN** the label of the p guide reads `p 1 × 10⁻⁷`, and the default guide reads `p 0.05`

#### Scenario: The effect axis is symmetric
- **WHEN** the largest effect is 5.93
- **THEN** the effect axis spans from −6 to 6

#### Scenario: A dense volcano reads the payload
- **WHEN** the caller renders a `volcano` over 9,000 rows, and the inline option passes the bound
- **THEN** the page option holds no point row, the page builds the same points from the payload, and the names ride the page option inline

### Requirement: The MA figure
An `ma` chart MUST draw the MA figure of the `plotMA` function of DESeq2. The figure reads the `x` channel for the mean and the `y` channel for the effect. It also reads the optional `p` and `label` channels, and the significance threshold.

- The mean axis is logarithmic. Its ends are the powers of ten around the positive means. A row whose mean is not positive draws no point.
- The `p` column splits the rows at the significance threshold. The threshold defaults to `0.1`, the default of DESeq2.
- A row under the threshold draws in the blue of the palette. Each other row draws in the muted gray, under the blue points. A row with no p-value draws gray, as `plotMA` draws it.
- The legend names the blue points with the column and the threshold, for example `padj < 0.1`.
- A guide line sits at zero, and the effect axis is symmetric around zero.
- A block with no `p` channel draws one series in the palette.

The figure MUST refuse each of these faults, and the problem names the cause:

- a block with no `x` channel or no `y` channel
- a transform on the `x` channel, because the axis is logarithmic
- a transform or an order on the `p` channel
- an effect threshold, because the figure splits the rows by the `p` column alone.

The page splits the rows of a dense MA figure by the same rule. The rule names the `p` column and the threshold as plain data. Thus the page and the server put each row in the same category.

#### Scenario: The mean axis is logarithmic
- **WHEN** the positive means run from 0.87 to 196,243
- **THEN** the mean axis is a log axis from 0.1 to 1,000,000

#### Scenario: The p column splits the rows
- **WHEN** the caller derives an `ma` with `p` on the `padj` column and no thresholds
- **THEN** the rows under 0.1 draw blue in the series `padj < 0.1`, and each other row draws gray, a row with no `padj` included

#### Scenario: A declared threshold moves the split
- **WHEN** the block declares the significance threshold 0.05
- **THEN** the blue series reads `padj < 0.05`, and a row at 0.08 draws gray

#### Scenario: The page splits the rows as the server does
- **WHEN** the caller renders a dense `ma`, and the inline option passes the bound
- **THEN** the data source carries the rule with the `p` column and the threshold, and the page builds the two series of the inline option

### Requirement: The Manhattan figure
A `manhattan` chart MUST draw the Manhattan figure of qqman and of GWAS papers. The figure reads the `x` channel for the cumulative position, the `y` channel for the p-value, and the `group` channel for the chromosome. It also reads the optional `label` channel. The figure applies `neg_log10` to the p-value.

- Each chromosome draws one series. The chromosomes alternate between the blue of the palette and the muted gray.
- The chromosomes read in genome order, whatever the order of the rows. The numbered chromosomes come first in numeric order, then X, Y, and MT, then each other name in text order. A `chr` prefix takes no part in the order. The alternate colors, the printed names, and the lead names read this order.
- A stored p-value of 0 draws an upward triangle at the largest finite −log10 p of the table, in the color of its chromosome. Where no finite p passes the genome-wide line, the triangle draws one unit over the line.
- The name of a chromosome sits under the middle of its points. The position axis shows no tick labels, and no legend draws.
- The derivation measures the chromosome names in the frame of each render, as the volcano measures its names. Each text centers under the middle of its chromosome. The width of a text is 0.6 of the text size for each character.
- A name prints only when its text starts half of the text size or more past the end of the last printed name. The first name always prints. Thus two names never print on top of each other at any size. On a page narrower than its frame, the runtime also hides a name that overlaps another.
- A guide line marks the genome-wide threshold 5e-8. Its label `p 5 × 10⁻⁸` sits over the line at the right end, inside the plot. Thus it stays clear of the axis and of the chromosome names. The box of the label is kept free when the lead names find their places, thus no lead name covers it. A second guide line marks the suggestive threshold 1e-5 with no label.
- The ten most significant lead variants can show the text of the `label` column, one for each chromosome at most. A render tries these leads in the order of their p-value while the summed width of their text fits the width of its frame. Thus a narrow export tries fewer names, and each name keeps room beside its peak.
- The derivation places each name as the volcano places its names, over its peak first, then at the right and at the left. A name over a peak near a side edge moves along the position axis until it fits inside the plot.
- The lead names and the chromosome names place again for each render. Each export takes the names of its size, as for the volcano names. The box of the guide label is measured in the frame of each render. On a page narrower than its frame, the runtime also hides a lead name that overlaps another name.
- The position axis spans the drawn positions. The p axis starts at zero, and it holds the genome-wide line.

The figure computes these summaries from the rows of each chromosome:

- The middle: the mean of the smallest and the largest drawn position.
- The lead variant: the row with the smallest p-value under 5e-8 that carries a name. A stored zero is the smallest p-value. A tie keeps the row at the smaller position.
- The labeled leads: the ten leads with the smallest p-value over the genome. A tie keeps the lead at the smaller position.
- The tried leads of each render: the labeled leads in order, while the summed width of their text fits the width of the frame.
- The place of each tried lead name in each frame, by the rule of the volcano names.
- The printed chromosome names of each frame.

The figure MUST refuse a block with no `x`, `y`, or `group` channel. The problem names the channel.

#### Scenario: The chromosomes alternate their colors
- **WHEN** the caller derives a `manhattan` over three chromosomes
- **THEN** the three series take the blue, the gray, and the blue

#### Scenario: The row order does not change the figure
- **WHEN** the caller derives a `manhattan` over one table sorted by position, and over the same table sorted by p-value
- **THEN** the two options give the same color to each chromosome, the same chromosome names, the same lead names, and the same axes

#### Scenario: The chromosomes read in genome order
- **WHEN** the rows name the chromosomes `MT`, `10`, `X`, `2`, `Un`, `1`, and `Y` in this order
- **THEN** the names read `1`, `2`, `10`, `X`, `Y`, `MT`, and `Un`, and the colors alternate in that order from the blue

#### Scenario: A stored zero leads its chromosome
- **WHEN** a variant of chromosome 2 holds the stored p-value 0
- **THEN** an upward triangle in the color of chromosome 2 draws at the largest finite −log10 p of the table
- **AND** the variant shows its name first

#### Scenario: The chromosome names sit under their points
- **WHEN** the drawn positions of chromosome 1 run from 1,082,207 to 248,900,000
- **THEN** the name `1` sits under the position 124,991,103.5 at the x axis

#### Scenario: The lead variants show their names
- **WHEN** chromosome 1 holds two rows under 5e-8, chromosome 2 holds one row under 5e-8 and one row at 3e-6, and chromosome 3 holds none
- **THEN** the row with the smaller p-value of chromosome 1 and the row under 5e-8 of chromosome 2 show their names, and no other row does

#### Scenario: Ten leads show their names
- **WHEN** each of twelve chromosomes holds one lead under 5e-8
- **THEN** the ten leads with the smallest p-values show their names, and the two weakest leads show none

#### Scenario: A lead name keeps clear of the guide label
- **WHEN** a lead variant just over the genome-wide line sits at the right end of the position axis
- **THEN** the label of the line sits over the right end of the line
- **AND** the name of the lead sits outside the box of that label

#### Scenario: A crowded chromosome name does not print
- **WHEN** in the page frame, the text of chromosome 2 starts 4.2 px after the end of the text of chromosome 1, and the text size is 12 px
- **THEN** the names `1` and `3` print, and the name `2` does not

#### Scenario: No name covers a name at any size
- **WHEN** the caller derives a `manhattan` over an excerpt of the BMI GWAS, and makes the export option of each export size
- **THEN** in the frame of the page and of each export size, no two lead-name boxes overlap
- **AND** each chromosome name starts at least half of the text size past the end of the name before it

#### Scenario: The 89 mm file prints fewer names
- **WHEN** the caller exports the Manhattan plot of the BMI excerpt at 89 mm and at 183 mm
- **THEN** the 89 mm file prints fewer lead names and fewer chromosome names than the 183 mm file

#### Scenario: A manhattan with no chromosome refuses
- **WHEN** the block names no `group` channel
- **THEN** the render returns a `RenderProblem` that states that the `manhattan` chart needs a column for the `group` channel

### Requirement: The QQ figure
A `qq` chart MUST draw the QQ figure of a GWAS, as qqman and the GWAS quality-control tools draw it. The figure reads the `x` channel for the expected −log10(p) and the `y` channel for the observed −log10(p). It also reads the optional `low` and `high` channels, and the statistics.

- The points draw small, in the ink of the page.
- The band between `low` and `high` draws in a light gray under the points.
- An identity line runs from zero to the largest expected value.
- Each axis has its own range from zero, as in qqman. The x axis ends at the round number at or past the largest expected value.
- The y axis ends at the round number at or past the largest observed value, the largest expected value, and the largest upper bound.
- The statistics print at the top left of the plot, for example `λ = 1.11`.
- Where the `y` channel applies `neg_log10` to a p column, a stored p-value of 0 draws an upward triangle at the largest finite observed value.
- No legend draws.

The figure computes one summary: the band reads at most 400 rows, spaced along the x axis. A band of 400 rows or fewer keeps each row. A longer band keeps the first row and the last row. Between them, a kept row sits one step or more past the kept row before it. It also sits one step or more before the last row. One step is the span over 399. Each vertex of the band is one row of the table.

The points of a dense QQ figure read the payload. The band draws after the points, and it keeps its rows inline, because its upper half holds the width of the band.

The figure MUST refuse a block with no `x` channel or no `y` channel. The problem names the channel.

#### Scenario: The band draws under the points
- **WHEN** the caller derives a `qq` with `low` and `high`
- **THEN** two stacked line series after the points fill the band in a light gray, under the points

#### Scenario: Each axis has its own range
- **WHEN** the largest observed value is 19.3, and the largest expected value is 6.41
- **THEN** the x axis spans from 0 to 8, the y axis spans from 0 to 20, and the identity line runs from 0 to 6.41

#### Scenario: The statistic prints at the top left
- **WHEN** the block binds the statistic `λ` to a cell that holds 1.1116
- **THEN** the top left of the plot prints `λ = 1.11`

#### Scenario: A long band keeps at most 400 rows
- **WHEN** the table holds 4,002 rows with both bounds, spaced evenly from 0 to 400
- **THEN** the band holds 400 rows or fewer, and it starts at 0 and ends at 400

#### Scenario: A dense QQ figure reads the payload and keeps its band inline
- **WHEN** the caller renders a `qq` over 20,000 rows, and the inline option passes the bound
- **THEN** the points read the payload, and the page option carries the thinned band inline

### Requirement: The page signals readiness after each chart draws in full
The chart bootstrap MUST signal readiness after each chart that it set fires its first `finished` event. The runtime draws a series of more than 3,000 points in chunks over some frames, and it fires `finished` after the last chunk. Thus a capture that keys on the signal shows each point. A chart whose option throws counts as finished, thus one fault never withholds the signal. A page with no chart signals at once.

The resize handler MUST draw a chart again only when the container of the chart changes size. A capture past the viewport resizes the window and keeps each container. A redraw there would restart the chunked render, and the capture would show the first chunk alone.

#### Scenario: The signal waits for the last chart
- **WHEN** the page holds two charts, and the first chart fires `finished`
- **THEN** the page does not signal readiness until the second chart fires `finished`

#### Scenario: A window resize keeps a chart of the same size
- **WHEN** the window resizes, and the container of a chart keeps its size
- **THEN** the chart does not draw again, and a container of a new size draws its chart again

### Requirement: The layout of one unit
A figure that puts one unit on x equal to one unit on y MUST draw its plot as a square in pixels. The two axes MUST span one length of data. The option holds no function, and no grid field of the chart runtime keeps an aspect. Thus each grid states its width and its height as one number of pixels.

The option MUST carry media rules for the square size. Each rule names the smallest container that holds one square size with its margins. The rules grow, and the runtime applies each rule that matches, thus the largest square that fits wins. The first rule matches each container, thus a container that shrinks falls back to the smallest square. Each rule states each grid, the legend, and each color scale in the band at the right of the squares. A rule for a square smaller than the page square also shrinks the points in proportion.

The panels of a facet lay out three to a row, and each panel is a square of one size. Each grid draws no label past its box, thus the runtime never shrinks a square to fit a label.

The page MUST center the square block in the card. The render states the width of the block at the height of the chart body, and the card narrows the body to that width. An export has a fixed size, thus the option MUST carry one more rule for each export size. Such a rule names its size as the smallest and the largest container. It places the largest square that fits, with the margins at the text size of the export, in the middle of the width.

A figure can put its legend in a band under the squares. The band holds the lines that the entries fill at the width of the square block. A color scale widens its band to the width of its title, thus the narrowed body never cuts the title.

#### Scenario: The square holds in each container
- **WHEN** the caller derives a `pca`
- **THEN** the grid states one number of pixels for its width and its height, and each media rule states a square

#### Scenario: A larger container takes a larger square
- **WHEN** the option holds its media rules
- **THEN** the first rule matches each container, and the square size of each later rule is larger than the size of the rule before it

#### Scenario: The page centers the square
- **WHEN** the caller renders a `pca`
- **THEN** the chart body states the width of the square block, and its margins center it in the card

#### Scenario: An export centers the square
- **WHEN** the export draws a `pca` at the single column, at the double column, or on the slide
- **THEN** a rule of that exact size matches, and the space at the left of the block equals the space at its right

#### Scenario: A column export shrinks the points
- **WHEN** the export draws an embedding at the single column
- **THEN** the matched rule states a point size under the point size of the page

### Requirement: The PCA figure
A `pca` chart MUST draw the PCA of samples, as the DESeq2 `plotPCA` figure draws it. The figure reads the `x` and `y` channels for two components, and the optional `group`, `shape`, and `label` channels.

- One unit on x equals one unit on y, by the layout of one unit.
- The two axes end on one round step, and they tick at that step. The shorter axis grows by whole steps to the length of the longer axis.
- The title of each axis is the declared label of its column. Thus the run states the variance of each component in the label, for example `PC1: 56.5% variance`.
- The `group` sets the color of each point, and the `shape` sets its symbol. Each pair of a group and a shape is one series, named by its group.
- The legend names each group with a circle in its color, and each shape with its symbol in the ink.
- A table of 20 rows or fewer names each point with its `label` text. A larger table names each point in the tooltip alone.

The figure computes one layout: the side of each point name. Each name takes the first free side, in the order right, left, top, and bottom. A free side covers no earlier name and no point, and the name stays inside the plot on that side. The derivation measures a name at a fixed square size, thus the place is a pure function of the rows.

The figure MUST refuse these blocks, and the problem names the cause:

- a `shape` channel of more than 6 categories.
- a value that names a group and a shape.
- an `orderBy` on a channel, because the figure draws no category axis.
- a component column that holds a text that is not a number.

A `scatter` with a `shape` channel MUST draw through the same shape draw. It draws on the fitted axes of a scatter, with the legend at the bottom. It names each point in the tooltip alone. It reads `x`, `y`, `group`, `label`, and `shape`, and it refuses each other channel and a focus beside the shape. The shape draw keeps its rows inline, because a page-side build draws no symbol.

#### Scenario: The PCA gives one unit to each axis
- **WHEN** the caller derives a `pca` over the seven pasilla samples
- **THEN** each axis spans from −10 to 15 with one tick step, on a square grid

#### Scenario: The shape sets the symbol beside the color of the group
- **WHEN** the block names `condition` as the `group` and `type` as the `shape`
- **THEN** one series draws for each pair, each series of one condition takes one color, and each type takes its own symbol

#### Scenario: The legend keys the groups and the shapes apart
- **WHEN** the block names a `group` and a `shape`
- **THEN** the legend names each group with a circle and each shape with its symbol in the ink

#### Scenario: A small table names each sample
- **WHEN** the table holds seven samples and a `label` channel
- **THEN** each point shows its name, and the name of a close neighbor moves to a free side

#### Scenario: A large table names no point
- **WHEN** the table holds 21 rows and a `label` channel
- **THEN** no point shows its name, and the tooltip names each point

#### Scenario: A seventh shape refuses
- **WHEN** the `shape` column holds seven categories
- **THEN** the render returns a `RenderProblem` that states that a symbol reads for 6 categories at most

#### Scenario: A scatter draws a shape
- **WHEN** the caller derives a `scatter` with a `shape` channel
- **THEN** each series carries the symbol of its shape, on fitted axes, with the legend at the bottom

#### Scenario: A scatter refuses a color beside a shape
- **WHEN** the caller derives a `scatter` with a `shape` channel and a `color` channel
- **THEN** the render returns a `RenderProblem` that names the `color` channel and the shape

### Requirement: The embedding figure
An `embedding` chart MUST draw the embedding of cells, as the scanpy `pl.umap` and the Seurat `DimPlot` draw it. The figure reads the `x` and `y` channels for two dimensions of a UMAP or a t-SNE. It reads one of `group` and `color`, and the optional `facet` and `label` channels.

- The axes hide their lines, their ticks, and their labels. A small key at the bottom left corner of the first panel names the two dimensions.
- One unit on x equals one unit on y, by the layout of one unit.
- The point size follows the cell count by the scanpy rule. The area of a point is 120000 / n square points, and the diameter is bounded from 1 to 6 pixels. The points draw with a light opacity.
- With `group`, each category name draws on the data in the ink with a white outline, and no legend draws. More than eight categories take the wide palette.
- With `color`, a zero draws in a light gray ground, and the scale clips at the 99th percentile. A value past the percentile draws in the top color, and the high values draw on top.
- A column that crosses zero takes the diverging scale, symmetric at the 99th percentile of the absolute values, and no ground.
- With `facet`, each value draws one square panel, and the panels share one range. Each panel shows its name over its square.

The figure computes these summaries:

- the cell count, which sets the point size.
- the median x and the median y of the cells of each category in each panel, where the name of the category draws.
- the 99th percentile of the color values, as the linear quantile of type 7.

A name that covers the name of a larger category moves along y by whole lines.

The points build through the composition machinery, thus a dense table reads the payload of its artifact. The category names draw as a small series after the points, and they keep their rows inline.

The figure MUST refuse a block that names neither `group` nor `color`, and a block that names both. The problem names the two channels.

#### Scenario: The axes hide and the key names the dimensions
- **WHEN** the caller derives an `embedding` over the PBMC 3k cells
- **THEN** each axis hides its line, its ticks, and its labels, and the key names `UMAP_1` and `UMAP_2` at the bottom left corner

#### Scenario: The point size follows the cell count
- **WHEN** the table holds 2,638 cells, and a second table holds 20,000 cells
- **THEN** the points of the first table are 6 pixels, and the points of the second table are 3.7 pixels

#### Scenario: Each category name sits at the median of its cells
- **WHEN** the caller derives an `embedding` with a `group` channel
- **THEN** a series after the points names each category at the median x and the median y of its cells, and no legend draws

#### Scenario: A zero draws in the ground
- **WHEN** the caller derives an `embedding` with a `color` channel whose column holds zeros
- **THEN** the scale starts at zero, a zero lies outside its selected range, and the ground color draws it

#### Scenario: The scale clips at the 99th percentile
- **WHEN** the color values run past their 99th percentile
- **THEN** the top of the scale is that percentile, and a value past it draws in the top color

#### Scenario: The high values draw on top
- **WHEN** the caller derives an `embedding` with a `color` channel
- **THEN** each series lists its points in the ascending order of the color

#### Scenario: A facet draws one square for each condition
- **WHEN** the caller derives an `embedding` of the Kang cells with a `facet` channel on the condition
- **THEN** the option holds two square grids of one size with one shared range, and each panel shows the name of its condition

### Requirement: The dot plot figure
A `dotplot` chart MUST draw the marker dot plot of a single-cell study and the enrichment dot plot of a gene-set test. The figure reads the `y` channel for the categories, and the `x` channel for categories or values. It reads a `size` channel, a `color` channel, or both, and the optional `label` channel.

- The y axis lists the categories top-down, in the order of the `orderBy` of the `y` channel, or in the order of the rows.
- The x axis draws categories where its column holds text, and values where it holds numbers. A value axis keeps room at each end, thus the largest dot stays inside the plot.
- The color scale is sequential over the drawn color values. Its title and its two ends print as text, and the number helper formats each end.
- A size legend draws three reference circles with their values: the smallest size, the middle of the range, and the largest size.
- A y category of more than 30 characters wraps at its spaces into lines of 30 characters. A term keeps two lines at most, and a longer term ends its second line with an ellipsis. Each term takes two lines and a gap, thus two terms never touch. A plot of many terms states a taller chart body.
- A transformed color or size titles its scale with the transform, for example `−log10(adjusted p)`, and its ends print as plain numbers.
- The figure moves each dot onto the place of its category, and the page does not do this move. Thus the rows of a dot plot stay inline whatever their count.

The figure computes these summaries: the two ends of the color scale over the drawn values, and the middle of the size range.

The figure MUST refuse a block with neither a `size` channel nor a `color` channel, and a transform on the `y` channel.

#### Scenario: The marker dot plot lists the clusters top-down
- **WHEN** the caller derives a `dotplot` of the PBMC 3k markers
- **THEN** the y axis lists the clusters from the top in the order of the rows, and the x axis lists the genes

#### Scenario: The size legend shows three circles
- **WHEN** the fraction of expressing cells runs from 0.0472 to 1
- **THEN** the size legend shows three circles with the values `0.0472`, `0.524`, and `1`

#### Scenario: The color scale is sequential with formatted ends
- **WHEN** the scaled mean expression runs from 0 to 1
- **THEN** the color scale takes the sequential ramp, and it prints `1` and `0` at its ends

#### Scenario: The enrichment dot plot orders the terms by their ratio
- **WHEN** the `y` channel orders the GO terms by the gene ratio, from the largest
- **THEN** the term with the largest ratio draws at the top

#### Scenario: A long term ends with an ellipsis
- **WHEN** a term reads `regulation of intracellular signal transduction pathway of the embryonic tracheal system (GO:1902531)`
- **THEN** the y label reads `regulation of intracellular` on the first line and `signal transduction pathway…` on the second line

#### Scenario: A dense dot plot keeps its rows inline
- **WHEN** the caller renders a `dotplot` of 3,000 terms, and the inline option passes the bound
- **THEN** the page option is the inline option, and it reads no payload

#### Scenario: A dot plot with no size and no color refuses
- **WHEN** the block names neither a `size` channel nor a `color` channel
- **THEN** the render returns a `RenderProblem` that names the two channels

### Requirement: The heatmap figure
A `heatmap` chart MUST draw a matrix of one value over each pair of two category columns, as pheatmap and ComplexHeatmap draw it. The figure reads the `x`, `y`, and `value` channels, the optional `tracks` channel, and the optional trees.

- The y axis lists its categories top-down. Each axis follows the leaf order of its tree, the `orderBy` of its channel, or the order of the rows.
- A value column that crosses zero, for example a z-score, takes the diverging scale centered on zero. Each other column takes the sequential scale.
- A distance matrix takes the sequential scale, whose dark end is the low value. Thus the diagonal of zero distance draws dark, as the DESeq2 sample-distance figure draws it.
- The cells stand apart by a white gap of 1 pixel, and the axes draw no line and no tick.
- When the x axis holds more than 40 categories, the x labels hide, and the axis title states the count, for example `sample (n = 41)`.
- pheatmap names each row. The default body holds a row of 16 px for a few rows alone. Thus a matrix of more rows states a taller chart body, up to the largest body. A y label that overlaps its neighbor hides. This occurs past the largest body, and in a column export whose rows are shorter than a line of text.

Each column of `tracks` MUST draw one strip of category colors over the matrix, in the order of the x axis. Each strip names its column at its left. Each strip has a legend of its own over the strips, with the title of its column. The legends take a band of their own: one line of 24 px for each legend, and a gap of 14 px over the strips. The categories of all strips take one palette in order, thus no two strips share a color. A track column holds one value for each x category.

The tree of an axis MUST draw as a dendrogram, as pheatmap draws it:

- The axis takes the leaf order of its tree. The leaf order is the depth-first order from the root, and the children of a node keep the order of the table.
- Each edge draws as one elbow. The elbow rises from the child to the height of the parent, then it runs across to the place of the parent.
- A leaf sits at height zero under its column or beside its row. An inner node sits at its height, midway between its outer children.
- The tree of `x` draws above the strips and the matrix, over the columns of the matrix. The root is at the top.
- The tree of `y` draws at the left of the row names, over the rows of the matrix. The root is at the left.
- Beside a tree of `y`, each row name and each strip title starts at the leaves. The strip legends start over the row names. Thus a column export keeps the names at the tree.
- The band of a tree is 48 px deep. The branches are thin lines in the ink color.

The figure computes these summaries: the category of each track at each x category, and the place and the height of each node of a tree.

The figure MUST refuse these blocks, and the problem names the cause:

- a repeated pair of an x category and a y category.
- a track column with two values for one x category.
- a count of cells past the slot bound.
- a transform on the `x` or the `y` channel.
- an `orderBy` on an axis that has a tree, because two orders conflict.
- a tree with no edge, or an edge with no parent or no child.
- a height that is not a number, or a node with two heights.
- a node with two parents, or one edge two times.
- a tree with no root or with more than one root.
- a cycle.
- a child over the height of its parent.
- a leaf that is no category of its axis, or a category that no leaf names.

#### Scenario: Each track draws a strip over the matrix
- **WHEN** the caller derives the pasilla heatmap of the top genes with the tracks `condition` and `type`
- **THEN** two strips draw over the matrix in the order of the samples, and each strip has a legend of its own

#### Scenario: The strips take different colors
- **WHEN** the two tracks hold two categories each
- **THEN** the four categories take the first four colors of the palette

#### Scenario: A z-score diverges
- **WHEN** the value column holds z-scores
- **THEN** the scale takes the diverging ramp, and its two ends are the same size

#### Scenario: The cells stand apart
- **WHEN** the caller derives a heatmap
- **THEN** the cells carry a white border of 1 pixel, and the axes draw no line

#### Scenario: A wide matrix hides its sample names
- **WHEN** the x axis holds 41 samples
- **THEN** the x labels hide, and the axis title reads `sample (n = 41)`

#### Scenario: Forty genes take a taller body
- **WHEN** the caller derives a heatmap of 40 genes with two tracks
- **THEN** the render states a chart body taller than 400 px, and each gene row takes 16 px of it at least

#### Scenario: The track legends stand clear of the strips
- **WHEN** the caller derives a heatmap with two tracks
- **THEN** the two legends stand 24 px apart, and the strips start 38 px under the top of the second legend

#### Scenario: A track with two values for one sample refuses
- **WHEN** the track column holds two conditions for one sample
- **THEN** the render returns a `RenderProblem` that names the column, the two values, and the sample

#### Scenario: Each axis takes the leaf order of its tree
- **WHEN** the caller derives the pasilla heatmap of the top genes with the sample tree on `x` and the gene tree on `y`
- **THEN** the samples read in the depth-first leaf order of the sample tree, and the genes read in the leaf order of the gene tree

#### Scenario: The trees draw beside their axes
- **WHEN** the caller derives the heatmap with a tree on each axis and two tracks
- **THEN** the tree of `x` draws above the strips across the matrix, and the tree of `y` draws at the left of the row names

#### Scenario: One tree serves both axes of a distance matrix
- **WHEN** the caller derives the sample distances with the same tree on `x` and on `y`
- **THEN** the two axes take the same leaf order, and two dendrograms draw

#### Scenario: The export keeps each tree as vector lines
- **WHEN** the export draws the heatmap with two trees at 89 mm and at 183 mm
- **THEN** each file holds one line for each edge of each tree

#### Scenario: A tree and an orderBy on one axis refuse
- **WHEN** the `x` channel names an `orderBy` column, and the block binds a tree of `x`
- **THEN** the render returns a `RenderProblem` that states that the axis takes the leaf order of its tree

#### Scenario: A missing leaf refuses
- **WHEN** the tree of `x` names no leaf for the sample `untreated3`
- **THEN** the render returns a `RenderProblem` that names the tree and the sample

#### Scenario: A child over its parent refuses
- **WHEN** a node of the tree sits at a height over the height of its parent
- **THEN** the render returns a `RenderProblem` that names the node, the two heights, and the parent

### Requirement: The UpSet figure
An `upset` chart MUST draw the UpSet plot of upset.app, UpSetR, and ComplexHeatmap. The figure reads the `x` channel for the element and the `group` channel for the set. The table holds one row for each member of each set.

- The top grid draws the size of each intersection as a dark bar, with its count over the bar.
- The middle grid draws the dot matrix. It has one column for each intersection and one row for each set. A dark dot marks each member set of the intersection, and a light gray dot marks each other set. A dark line joins the top and the bottom member dot of each column.
- The left grid draws the size of each set as a dark bar that grows to the left. The set names sit between these bars and the matrix. The set bars show on each chart.
- The three grids line up. The top bars share the columns of the matrix, and the set bars share its rows.
- The sets sort by size, and the largest set is at the top. A tie keeps the first appearance in the rows.
- The intersections sort by size, and the largest is first. A tie sorts by the degree, and the smallest degree is first. A second tie sorts by the set order of the members.
- The figure draws 30 intersections at most. Past that bound, the largest 30 draw, and the title under the matrix states the count, for example `Intersections: 30 of 40 shown`.
- A row with an empty set cell names an element in no set. The row adds nothing, and the empty intersection draws no column.
- The dot size and the line width change with the size of one cell at the page and at each export size. A count text wider than its column turns upright.

The figure computes these summaries from the rows of the bound table:

- The size of a set: the count of its distinct elements.
- The exact intersection of an element: the combination of all sets that hold the element. The size of an intersection is the count of its elements. Thus each element counts in one intersection only.

The figure MUST refuse each of these faults, and the problem names the cause:

- a block with no `x` or `group` channel
- a transform or an order on a channel
- a table with no rows
- two rows that state one element in one set
- a row that names a set and no element
- a table that names no set
- a table of more than 12 sets. Each set takes one row of the matrix, and 12 rows hold one line of text each at the single journal column.

#### Scenario: The summary gives the set sizes and the exact intersections
- **WHEN** the caller derives an `upset` over the LAML membership table of 115 samples and six genes
- **THEN** the set bars read FLT3 52, DNMT3A 48, NPM1 33, IDH2 20, IDH1 18, and TET2 17, from the top down
- **AND** the matrix holds 26 columns, and the column sizes add to 115

#### Scenario: The intersections sort by size, then by degree
- **WHEN** one element holds DNMT3A, FLT3, and NPM1, and one element holds FLT3 alone
- **THEN** the column of FLT3 alone comes before the column of the three genes

#### Scenario: The matrix joins the member dots
- **WHEN** an intersection holds FLT3 and NPM1
- **THEN** its column draws a dark dot on the rows of FLT3 and NPM1, and a light gray dot on each other row
- **AND** a line joins the two dark dots

#### Scenario: The cap hides the smallest intersections
- **WHEN** the table holds 40 intersections
- **THEN** the top grid draws 30 bars, and the title under the matrix reads `Intersections: 30 of 40 shown`

#### Scenario: A repeated membership refuses
- **WHEN** two rows state the sample `TCGA-AB-2806` in the set `FLT3`
- **THEN** the render returns a `RenderProblem` that names the element and the set

#### Scenario: Too many sets refuse
- **WHEN** the table names 13 sets
- **THEN** the render returns a `RenderProblem` that states 13 sets and the bound of 12

### Requirement: The Sankey figure
A `sankey` chart MUST draw the flows between the nodes of some stages through the `sankey` series of the chart runtime. The figure reads the `x` channel for the source node and the `y` channel for the target node. The `value` channel gives the size of the flow. It also reads the optional `group` channel. The table holds one row for each flow.

- The nodes keep the order of their first appearance in the rows. The layout runs no iteration (`layoutIterations: 0`). Thus the table order is the order of the nodes in each stage.
- The palette starts again at each stage. Each node takes the Okabe-Ito color of its place in its stage. A stage of more than eight nodes takes the wide palette. Each flow takes the color of its source node at a light opacity.
- With a `group` channel, each flow takes the palette color of its group, and the nodes draw gray. A legend names each group. Two flows of one pair of nodes draw apart when their groups are different.
- Each label sits beside its node. A label sits at the left of a node of the last stage, and at the right of each other node. Thus each label stays inside the chart.
- A label draws over the flows of its node. Each line of a label sits on a box of the page color, and the box fits the text of the line. Thus no flow covers a label. This rule is necessary for a thin node, because its flow starts under its label.
- The gap between two nodes of one stage holds one label line, and a label sits at the middle of its node. Thus the label of a thin node does not overlap the label of its neighbor. If the stage of the most nodes has no room for that gap, the gap is smaller. The gaps of a stage take half of its height at most.
- A label that still overlaps a neighbor label is hidden, and the tooltip of its node gives the name.
- A label wraps into the room between two stages. The page and one media rule for each export size state the label size, the wrap width, the node width, and the node gap. Thus the labels read at the single journal column.
- The tooltip of a flow names its two nodes and its value. The name of the series is the label of the `value` column.

The figure computes one summary from the rows of the bound table: the stage of a node. The stage is the longest chain of flows from a node with no inflow. A node with no outflow takes the last stage, thus the ends of the flows line up at the right. The chart runtime gives each node the size of its larger total: the inflow or the outflow.

The figure MUST refuse each of these faults, and the problem names the cause:

- a block with no `x`, `y`, or `value` channel
- a transform or an order on a channel
- a table with no rows
- a row that names no source node or no target node
- a flow from a node to the same node
- a flow value that is not a number, and a flow value of zero or less
- two rows of one flow: one source, one target, and one group
- a cycle. The problem names the nodes of the cycle in order.

#### Scenario: The nodes keep the table order
- **WHEN** the caller derives a `sankey` over the LAML flows from the FAB subtype to the FLT3 status and the vital status
- **THEN** the option holds one `sankey` series with `layoutIterations: 0`, and its nodes keep the order of their first appearance in the rows
- **AND** each FAB subtype takes the stage 0, each FLT3 status takes the stage 1, and each vital status takes the stage 2

#### Scenario: A node with no outflow takes the last stage
- **WHEN** the flows run from A to B, from B to C, and from A to D
- **THEN** the node D takes the stage 2, the same stage as C

#### Scenario: The flows take the color of their source
- **WHEN** the block names no `group` channel
- **THEN** the palette starts again at each stage, and each flow takes the color of its source at a light opacity
- **AND** the two FLT3 nodes of the LAML flows take blue and vermilion

#### Scenario: The labels read at the single journal column
- **WHEN** the export draws the chart at 89 mm
- **THEN** each label takes the print text size, and it wraps into the room between two stages
- **AND** the gap between two nodes of the first stage holds one label line, thus the labels of M6, M7, and `FAB unknown` do not overlap

#### Scenario: No flow covers a label
- **WHEN** the export draws the LAML flows at 89 mm and at 183 mm
- **THEN** the label `M7` draws after each flow, on a box of the page color
- **AND** the box fits the text of the label, and not the wrap width

#### Scenario: A cycle refuses
- **WHEN** the rows hold a flow from `Dead` back to `M1`
- **THEN** the render returns a `RenderProblem` that names the nodes `M1`, `Intermediate`, `Dead`, and `M1` in order

#### Scenario: A flow of zero refuses
- **WHEN** the flow from `M1` to `Poor` holds the value 0
- **THEN** the render returns a `RenderProblem` that names the two nodes and the value

### Requirement: The regional association figure
A `locuszoom` chart MUST draw the regional association plot of LocusZoom. The figure reads these channels:

- `x`: the position in base pairs on one chromosome.
- `y`: the p-value. The figure applies `neg_log10` to it.
- `color`: the r² of each variant with the lead variant.
- `label`: the name of each variant. This channel is optional.
- `metric`: the recombination rate in cM/Mb. This channel is optional.
- `group`: the chromosome of each row. This channel is optional.
- `track`: the genes of the region. The track is optional.

The figure draws these elements:

- Each point takes the color of its r² bin: navy for 0 to 0.2, sky blue for 0.2 to 0.4, green for 0.4 to 0.6, orange for 0.6 to 0.8, and red for 0.8 to 1. A bin holds its lower end, and the highest bin also holds 1. A point with a higher r² draws on top.
- A point with no r² draws in gray under the colored points.
- One legend over the plot gives the title `r²`, the five bins, and the gray entry `No r²`. A click on the legend hides no point. Each export keeps the icons of the legend at their size.
- The lead variant draws as a purple diamond over its point, and its name sits on top of the diamond.
- The recombination rate draws as a blue line on a right axis, from the rows in position order. The right axis starts at 0, and it ends at the round number at or past the largest rate. Its title is the declared label of the column, else `Recombination rate (cM/Mb)`.
- A guide line marks the genome-wide threshold 5e-8. The p axis starts at 0, and it holds the guide line and the lead.
- The label `p 5 × 10⁻⁸` of the guide line sits over the line, inside the plot. It starts at the first free spot from the left end. In a free spot, no variant and no part of the recombination line meets the box of the label. Thus the label stays clear of the right axis and of the recombination line.
- If no spot is free, the label starts at the first spot where the fewest marks meet its box. A halo of the page color around each letter keeps the label clear of those marks.
- The position axis reads in megabases. The chart runtime takes no function in the option. Thus the axis hides its own labels, and a series of named points prints each tick name.
- The axis ends at the smallest and the largest position. The tick step is the smallest round step that gives 5 steps or fewer across them. A tick sits at each multiple of the step. Each tick name has the decimals of the step, for example `54.0` for a step of 0.1 Mb.
- The title of the position axis is the declared label of the column with the unit `(Mb)`. A declared unit in parentheses changes to `(Mb)`. With no label, the title names the chromosome of the `group` column, for example `Position on chr16 (Mb)`. With no chromosome, the title is `Position (Mb)`.
- Each gene of the track draws as a line under the plot, with its name in italics under the line. The window clips each gene, and a gene outside the window draws nothing. The name of a gene stays inside the window.
- The track gives no strand column to the figure, thus a gene draws no strand arrow.
- A stored p-value of 0 draws an upward triangle, as the Manhattan figure draws it. The triangle takes the color of its r² bin.

The figure computes these summaries from the rows:

- The lead variant: the row with the largest −log10 p. A stored zero is the largest. A tie keeps the row at the smaller position, then the first row.
- The window: the smallest and the largest position, and the tick step.
- The start of the guide label. The box of the label reads the single-column export, because there the label takes the largest share of the plot. Thus a spot that is free at that size is free at each size.
- The lane of each gene. The genes take the lanes in the order of their starts. A gene takes the first lane where its line and its name overlap no earlier gene. The width of a name is its width at the single-column export. A band of more than 3 lanes makes the chart body taller.

The points and the recombination line read the shared payload of the artifact past the inline bound. The points with no r², the stored zeros, the tick names, the lead, and the genes keep their rows inline.

The figure MUST refuse each of these faults, and the problem names the cause:

- a block with no `x`, `y`, or `color` channel
- a transform or an order on the `x`, `color`, `metric`, or `group` channel
- a position that is not a number. The problem names the row and the cell.
- a `group` column with 2 chromosomes or more. The problem names 2 of them.
- an r² less than 0 or more than 1. The problem names the row and the value.
- a track that does not hold a named column

#### Scenario: The points take the LD bins
- **WHEN** the caller derives a `locuszoom` whose rows hold the r² values 0.05, 0.3, 0.5, 0.7, and 0.93
- **THEN** the legend gives the five bins from red to navy and the gray entry `No r²`
- **AND** each point takes the color of its bin

#### Scenario: A variant with no r² draws gray
- **WHEN** a variant holds a p-value and an empty r² cell
- **THEN** the variant draws in gray under the colored points

#### Scenario: The lead variant is a purple diamond
- **WHEN** the variant `rs1558902` holds the smallest p-value of the rows
- **THEN** a purple diamond draws at its point, and the name `rs1558902` sits on top of it

#### Scenario: The recombination line reads the right axis
- **WHEN** the rows hold the rates 0.1 to 31 cM/Mb in no order of position
- **THEN** a blue line joins the rates in position order on a right axis from 0 to 40

#### Scenario: The position axis reads in megabases
- **WHEN** the positions of chromosome 16 run from 53,650,000 to 54,080,000
- **THEN** the axis runs from 53.65 to 54.08 Mb, with the tick names `53.7`, `53.8`, `53.9`, and `54.0`
- **AND** the axis title is `Position on chr16 (Mb)`

#### Scenario: The genes take lanes that do not overlap
- **WHEN** the track holds `RPGRIP1L` and `MIR1972`, whose spans overlap, and `AKTIP` outside the window
- **THEN** `RPGRIP1L` and `MIR1972` draw in two lanes
- **AND** `AKTIP` draws nothing

#### Scenario: The guide label starts at the left end
- **WHEN** no variant and no part of the recombination line meets the box of the label at the left end
- **THEN** the label `p 5 × 10⁻⁸` sits over the guide line at the left end of the plot, far from the right axis

#### Scenario: The guide label moves past the recombination line
- **WHEN** the recombination line crosses the box of the label in the first 200 kb of the window
- **THEN** the label starts after those 200 kb

#### Scenario: The guide label takes the spot of the fewest crossings
- **WHEN** the recombination line crosses the box of the label at each spot of the window
- **THEN** the label starts at the first spot of the fewest crossings, and a halo of the page color surrounds each letter

#### Scenario: A dense window reads the payload
- **WHEN** the caller derives a `locuszoom` of 20,000 variants past the inline bound
- **THEN** the points and the recombination line read the shared payload
- **AND** the page builds each of them with the same items as the server

#### Scenario: Two chromosomes refuse
- **WHEN** the `group` column holds `16` and `17`
- **THEN** the render returns a `RenderProblem` that names the two chromosomes

#### Scenario: An r² outside 0 to 1 refuses
- **WHEN** row 9 holds the r² 1.2
- **THEN** the render returns a `RenderProblem` that names the row and the value

### Requirement: The toolbox of a page chart
Each chart on the page MUST carry a toolbox of the chart runtime at the top right of the chart body. The chart card adds the toolbox to the option of the page, and the derived option holds none. The toolbox holds these controls:

- A download control with a download icon. It is the last control, thus it sits at the right edge.
- A read-only data view. It shows the plotted rows of each series as one plain table, up to 1,000 rows. A note states the count of the rows that the view does not show. The view skips a series that the reader cannot hover, and it shows a number of a category axis as its category.
- A zoom control and a restore control, on a dense cartesian chart type only: `scatter`, `embedding`, `volcano`, `ma`, `manhattan`, `qq`, and `locuszoom`. The rule reads the chart type, and never the members of a figure.

The toolbox MUST hold no control that changes the chart type, because a reader must not change the form that the author chose.

The option stays JSON. Each handler of the toolbox is the name of a page function. The page script binds each function to its name after it parses the option, and before the chart reads the option. The script removes a name that the page does not hold. The print hides the toolbox of each chart, and the end of the print shows it again. Each export removes the toolbox, thus a file never shows it.

#### Scenario: A dense chart gets the zoom
- **WHEN** the caller renders a `manhattan` chart
- **THEN** the toolbox of the page option holds the zoom, the restore, the data view, and the download controls, in that order

#### Scenario: A bar gets no zoom
- **WHEN** the caller renders a `bar` chart
- **THEN** the toolbox of the page option holds the data view and the download control, and no other control

#### Scenario: The page script binds each handler
- **WHEN** the page script parses an option with a toolbox
- **THEN** the download handler and the content of the data view are page functions before the chart reads the option

#### Scenario: The print hides the toolbox
- **WHEN** the browser starts a print of the page
- **THEN** the page script hides the toolbox of each chart, and it shows each toolbox again after the print

#### Scenario: The data view holds back a long table
- **WHEN** a reader opens the data view of a Manhattan plot of 25,813 variants
- **THEN** the view shows the first 1,000 rows and states that the plot holds 25,813 rows

### Requirement: The download menu of a chart
The download control MUST open the download menu of its chart. The menu follows the option script in the chart card. It holds the two SVG entries, a rule, and the three PNG entries. An SVG entry links the staged file of its column, or it builds the hybrid SVG file of a dense chart. The page makes the file of each PNG entry on a click.

The chart runtime draws the download icon on the canvas, and it binds a mouse click alone. Thus the title line of the card MUST also hold a download button that the keyboard reaches. The button states `aria-haspopup="menu"`, and `aria-expanded` states the open menu. A click, `Enter`, or `Space` on the button opens the same menu as the icon. The print hides the button.

The menu opens under the download icon, at the right edge of the chart body, and the first entry gets the focus. The arrow keys, `Home`, and `End` move the focus between the entries. `Escape` closes the menu and gives the focus back to the button.

`Tab` closes the menu and puts the focus on the button, thus the next Tab stop comes after the button. A click on an entry closes the menu and gives the focus back to the button. A click outside the menu closes it. A second click on the icon or on the button closes the menu. The menu stays closed until the page script opens it, and the print hides it.

The file name of each entry states the chart and the size, for example `pathway-scores-89mm.svg`.

#### Scenario: The menu holds the five entries
- **WHEN** the caller renders a chart block under the point bound
- **THEN** the menu after the option script holds `SVG · 89 mm`, `SVG · 183 mm`, `PNG · 89 mm`, `PNG · 183 mm`, and `PNG · 16:9`, and it stands closed

#### Scenario: The keyboard moves in the menu
- **WHEN** a reader opens the menu and pushes the down arrow key, then `Escape`
- **THEN** the focus moves from the first entry to the second entry, and the menu closes

#### Scenario: An outside click closes the menu
- **WHEN** a reader opens the menu and clicks outside it
- **THEN** the menu closes

#### Scenario: The keyboard alone downloads a chart
- **WHEN** a reader moves to the download button with `Tab` and pushes `Enter`
- **THEN** the menu opens, the button states `aria-expanded="true"`, and the first entry has the focus
- **AND** `End` and `Enter` download the slide PNG, the menu closes, and the button has the focus again

### Requirement: The hybrid SVG of a dense chart
A chart past the point bound of the export can hold a point layer. The page MUST then build its two SVG files on a click. A point layer is a `scatter` series whose symbol draws and which shows no series label. The page builds the file in these steps:

1. The page draws the export option with the SVG renderer at the export size. Each point layer keeps only its rows that carry a label. It also gets two anchors with no symbol, at the least and the greatest value of each dimension. Thus each axis keeps the extent of the full rows.
2. The page reads the rectangle of each grid that holds a point layer from the chart runtime. It also reads the extent of each continuous axis of that grid. The page starts the search of a grid from the middle of a layer that holds rows. A facet panel can hold no row of one category, thus a layer with no row gives no start. A grid whose each layer is empty draws no point, and it gets no rectangle.
3. The page draws the point layers alone on a canvas at 300 DPI. Each grid stands at its measured rectangle, and each axis holds its measured extent. Each other element draws nothing.
4. A pure function puts the canvas image into the SVG as one `<image>` element at the grid rectangle, under the vector marks. The image reaches past the grid by half of the largest symbol, thus a point on an edge keeps its whole symbol.

The file keeps the export size, the print text size, and the root size in millimeters of a staged SVG. The file takes the name of a staged file. A page function and a TypeScript function hold the rule of a point layer and the composition, and one shared test vector runs both functions.

A chart past the point bound that holds no point layer gets no SVG, and its menu states that the PNG serves the chart.

When the page cannot build the file, the menu stays open. It shows a note that tells the reader to use a PNG, and the note gets the focus. The close of the menu hides the note again.

#### Scenario: The hybrid file of a Manhattan plot
- **WHEN** a reader clicks the `SVG · 89 mm` entry of a Manhattan plot of 25,813 variants
- **THEN** the page downloads an SVG with a root of 89 × 67 mm. The file holds the axes and the names as vector text, and one image of the points

#### Scenario: The image sits under the vector marks
- **WHEN** the composition puts the point layer into an SVG of the chart runtime
- **THEN** the image follows the background rectangle, and each axis, guide, and name draws over it

#### Scenario: The empty draw keeps the axes
- **WHEN** the page draws the vector file with the rows of each point layer removed
- **THEN** the grid rectangle and the extent of each axis equal those of the draw with the full rows

#### Scenario: A facet panel with an empty layer keeps its rectangle
- **WHEN** a faceted embedding past the point bound holds no cell of one type in one panel
- **THEN** the page starts the search of that panel from a layer that holds rows, and the file holds the image of each panel

#### Scenario: A failed build shows a note
- **WHEN** a reader clicks an SVG entry, and the page cannot build the file
- **THEN** the menu stays open, and the note that tells the reader to use a PNG shows and has the focus

#### Scenario: A dense line gets no SVG
- **WHEN** the caller renders a `line` chart past the point bound
- **THEN** the menu holds no SVG entry, and it states that the PNG serves the chart
