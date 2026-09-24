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

The table header MUST show the declared label of a column, with the raw column name in the `title` attribute of the header. An axis whose channel reads a labeled column MUST carry the label as its axis title. An undeclared header MUST prettify as the fallback: underscores become spaces, with the raw name on hover when the two differ. An undeclared axis keeps the raw name.

#### Scenario: The header shows the label with the raw name on hover

- **WHEN** the table view renders a column declared with a display label
- **THEN** the header shows the label, and the `title` attribute of the header holds the raw name

#### Scenario: The axis carries the label

- **WHEN** the chart derivation names an axis for a channel whose column carries a declared label
- **THEN** the axis title is the label, and the derivation stays deterministic

#### Scenario: An undeclared header prettifies

- **WHEN** the table view renders the column `gene_symbol` with no declared label
- **THEN** the header shows `gene symbol`, and the `title` attribute of the header holds the raw name

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

### Requirement: The composition derivation
The renderer MUST derive one option from a chart composition: one runtime series for each declared series, over the resolved rows of the one bound table. A transform applies per row, and `rank` ranks the column deterministically with shared ranks on ties. The label column rides each data item, and a static template formatter shows the name with the values. A reference line and a reference band derive as static mark members. Point labels show on the declared top-N subset alone. The label flags MUST survive a series split: when a group channel or a preset classification splits the rows, each flagged row carries its label in the series that holds it. An axis title replaces the raw column name where the author gives one, and a `log` scale maps onto the static axis type.

A preset MUST expand into a composition through one pure expansion, before the derivation. The `km` preset renders precomputed survival columns as grouped step series, and the renderer estimates nothing. The `volcano` preset MUST classify each row against its thresholds, per row and with no aggregate. It emits three series: the two signal categories on the palette, and the null category on the muted chart color by construction. The classification and the guide lines MUST read one threshold pair, thus the color split always lands on the lines. Declared thresholds on the block replace the preset constants, and the defaults stay as they are.

A dense scatter takes its symbol from a ladder. Over the hover threshold, the series takes the larger hit symbol, thus a point stays hoverable. Over the crowd threshold, the series takes a small symbol with reduced opacity instead. Per-point hover is lost in a crowd, thus shape legibility wins there. The derivation MUST stay deterministic, and it MUST compute no aggregate.

Two authoring faults MUST refuse as render problems. A band whose lower bound sits above its upper bound refuses, and the problem names the block. A quick-path transform whose derived name collides with a real table column refuses, and the problem names the collision.

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

### Requirement: The table data rides a data-script asset
The renderer MUST emit the bound table of each table block as a columnar data-script payload: a columns list, row arrays, and a dictionary for a string that occurs more than one time. The payload registers under one global map, keyed by the block id, and a classic `script` tag references the asset. The payload MUST carry the pre-bound row total of the artifact beside its rows. The table markup holds the header and no data rows. The renderer MUST return the payloads beside the page string, because the renderer writes no file. The payload derivation MUST be deterministic, thus two renders of one document give byte-identical payloads.

A chart whose derived option would exceed the inline bound MUST read its rows from a registered payload, under the same global map. A chart and a table over one artifact MUST share one payload. The page script builds the series from the columns, and the label rides as a column index, not a per-point copy. A chart under the inline bound keeps its inline option, exactly as before.

The payload rule reaches a chart whose every series draws one point for one row. A series that holds a value which no cell of the table gives keeps its rows inline, whatever the size of the option. A binned count, a five-number summary, an addressed pair, and the upper half of a band are each such a value. No descriptor can state one.

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
A preset MUST fill its semantic axis titles. A volcano titles "log2 fold change" and "−log10(p)", and a manhattan titles "−log10(p)" on its y axis. The precedence, most specific first: an agent axes title, a declared column label, the preset title, then the raw or derived name.

The null category of a preset classification MUST take the muted chart color of the design source by construction. An agent-derived category whose value reads as the null token — `ns`, `n.s.`, or `not significant`, case-insensitive — MUST take the muted color too. Thus the significant categories carry the color, and the null category recedes.

The value label of a vertical reference line MUST sit at the axis end, out of the title band. A vertical reference band labels the same way. A horizontal line keeps its label at the right edge.

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
- **WHEN** the caller derives a chart with a vertical reference line
- **THEN** the value label of the line sits at the axis end, and the title band stays clear

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
The binding of each evidentiary block MUST join the ladder: the metric value, the table, the chart, and the figure beside the claim and the citation. The card shows the marker, and the appendix entry names the path in its entry form. The appendix entry of a derived path MUST add the chain of its record: each source path with its hash prefix, and the script hash prefix. The chain MUST link the staged script asset of the record, and it MUST link the derived output file. Thus the chain walks offline, from the chart to the sources and the script that made the table. The derivation records ride the render call, exactly as the citation records do, and the renderer stays pure.

#### Scenario: A bound table gains its appendix entry
- **WHEN** the caller renders a table block over a pinned artifact
- **THEN** the card carries a marker, and the appendix names the path

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
