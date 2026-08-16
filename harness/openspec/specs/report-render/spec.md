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

#### Scenario: A section renders as a heading by depth
- **WHEN** the caller renders a section with a nested child section
- **THEN** the outer title renders as a higher heading level than the inner title

#### Scenario: A metric renders as a labeled value
- **WHEN** the caller renders a metric block with a scalar value entry
- **THEN** the page shows the label and the scalar value together

#### Scenario: A table renders every resolved row
- **WHEN** the caller renders a table block whose value entry holds three rows
- **THEN** the page holds an HTML table with the three rows, and no sample note

#### Scenario: A figure renders from the supplied source
- **WHEN** the caller renders a figure block with a figure source string and a caption
- **THEN** the page holds an image with that source, and the caption below it

#### Scenario: An empty table renders its header alone
- **WHEN** the caller renders a table block whose value entry holds zero rows and named columns
- **THEN** the page holds the table with its header, and no data row

#### Scenario: An empty chart still renders its container
- **WHEN** the caller renders a chart block whose value entry holds zero rows
- **THEN** the page holds the chart container, and the inline option holds an empty data list

### Requirement: The number format of a resolved value
The renderer MUST format each numeric value that it shows, through one number helper and its closed set of kinds. The kinds are `scientific`, `compact`, `compact-scientific`, `identifier`, and `below-resolution`. The helper applies to the metric value and to each numeric table cell. The renderer picks the kind by magnitude and by column meaning, and no block carries a format field.

A zero in a column whose meaning is a p-value MUST NOT render as a bare `0`. In a table, the cell MUST render `<` the smallest positive value of the same column, rounded up to one significant digit. A stored zero means that the true value sits under the resolution of the estimator, and the smallest positive neighbor bounds that resolution from above. Thus the shown claim is always true. When the column holds no positive value, and on a metric, the form MUST be `≈0`. The raw stored cell MUST ride in the `title` attribute. A zero outside a p-value column keeps its `0`, because a zero count and a zero effect are real values.

The chart option rides as inline JSON, thus no function can format an axis tick. The derivation MUST bound an axis only where a static option field can state the bound. The count axis of a histogram holds whole ticks. Every other axis keeps the tick algorithm of the chart runtime.

When the shown form hides digits, the element MUST carry the full digits in its `title` attribute. When the shown form hides no digit, the element carries no `title` attribute. The helper MUST be deterministic: it reads no locale, thus the same value gives the same text on every host.

The kind resolution MUST read a declared column meaning first, and the name guess is the fallback for an undeclared column. A declared meaning replaces the name test alone, and the magnitude arms stay. Thus a declared column renders byte-identically to a name-matched column of the same nature.

#### Scenario: A p-value renders in the scientific kind
- **WHEN** the caller renders a metric whose value resolves to `0.0000427777663038`
- **THEN** the card shows a scientific form such as `4.3e-5`, and the `title` attribute holds the full digits

#### Scenario: A long float renders with few significant digits
- **WHEN** the caller renders a table cell that holds `-3.089028528355109`
- **THEN** the cell shows a short form such as `-3.09`, and the `title` attribute holds the full digits

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

### Requirement: The table enhancer
The page MUST enhance each rendered table with a header sort, one filter input, and a row cap, through a page script with no dependency. The DOM MUST hold every resolved row, and the enhancer hides a row with a class and never removes one. The sort MUST read a raw value attribute that the view emits, thus the formatted text stays presentation. A numeric column sorts numerically, and every other column sorts in code-unit order. The cap is a renderer constant, and a table over the cap MUST carry a toggle that names the total row count. The print form MUST show every row. A browser without script keeps the complete plain table.

The renderer MUST trim a percent-delimited display name to its first segment. The full text rides the `title` attribute.

#### Scenario: The rows stay in the DOM under the cap
- **WHEN** the caller renders a table with more rows than the cap
- **THEN** the markup holds every row, the rows past the cap carry the hidden class, and the toggle names the total

#### Scenario: A sort reads the raw value
- **WHEN** the view renders a numeric cell with a formatted text
- **THEN** the cell carries the raw value in a data attribute, and the enhancer sorts by that value

#### Scenario: A small table carries no toggle
- **WHEN** the caller renders a table at or under the cap
- **THEN** no row carries the hidden class, and no toggle renders

#### Scenario: A noisy name trims with the full text on hover
- **WHEN** a cell holds a percent-delimited set name
- **THEN** the cell shows the first segment, and the `title` attribute holds the full text

#### Scenario: The print form shows every row
- **WHEN** the reader prints a page with a capped table
- **THEN** the print rules reveal each hidden row

#### Scenario: A scriptless browser sees the whole plain table
- **WHEN** the page loads with scripting disabled
- **THEN** every row paints, and no inert control shows, because the sheet hides and shows only under the live marker

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

#### Scenario: A bar chart derives its axes from the encoding
- **WHEN** the caller renders a bar chart with `x` and `y` in the encoding and resolved rows
- **THEN** the inline option holds the category axis from `x` and the values from `y`

#### Scenario: The normalize discipline applies
- **WHEN** the caller renders a chart block
- **THEN** the inline option carries the normalized layout, and it carries no in-spec title

### Requirement: The composition derivation
The renderer MUST derive one option from a chart composition: one runtime series for each declared series, over the resolved rows of the one bound table. A transform applies per row, and `rank` ranks the column deterministically with shared ranks on ties. The label column rides each data item, and a static template formatter shows the name with the values. A reference line and a reference band derive as static mark members. Point labels show on the declared top-N subset alone. An axis title replaces the raw column name where the author gives one, and a `log` scale maps onto the static axis type.

A preset MUST expand into a composition through one pure expansion, before the derivation. The `km` preset renders precomputed survival columns as grouped step series, and the renderer estimates nothing. A dense scatter over a row-count threshold takes a larger symbol size. The derivation MUST stay deterministic, and it MUST compute no aggregate.

Two authoring faults MUST refuse as render problems. A band whose lower bound sits above its upper bound refuses, and the problem names the block. A quick-path transform whose derived name collides with a real table column refuses, and the problem names the collision.

#### Scenario: A volcano derives from the preset
- **WHEN** the caller renders a `volcano` chart over an effect column and a p column
- **THEN** the option holds a scatter over the effect and the transformed p, with the declared guide lines

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

### Requirement: The per-type derivation rules
The renderer MUST hold one fixed derivation rule for each chart type. A chart whose encoding lacks a column that its type demands MUST give a `RenderProblem`. The renderer MUST compute no aggregate, and a pie or heatmap entry with a repeated category MUST give a `RenderProblem`. The histogram MUST bin with the auto rule: the larger of the Sturges count and the Freedman-Diaconis count. The box MUST compute type-7 quantiles with Tukey fences at 1.5 IQR. Category order and group order MUST follow the first appearance in the rows.

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

### Requirement: The claim evidence renders as markers and a provenance appendix
A claim MUST render its prose with evidence markers. The references MUST list at the end of the page under the title "Data provenance", styled as a muted appendix. The literature renders from citation blocks, and it stays separate from the appendix. The markers number by first appearance. An identical reference MUST appear one time in the list. Reference identity is the full reference value after a stable serialization, thus two references are identical only when every field matches. A derivation reference MUST list as its operation with its two pinned inputs, each named by path and locator.

#### Scenario: Two claims share one reference
- **WHEN** the caller renders two claim blocks that carry the same reference
- **THEN** both claims show the same marker number, and the list holds one entry for it

#### Scenario: The appendix wears the provenance title
- **WHEN** the caller renders a document with a claim
- **THEN** the list at the end of the page is titled "Data provenance", and no auto-generated surface is titled "References"

### Requirement: The page stands alone
The skeleton MUST inline the style rules. The page MUST reference each script and each font as a relative `assets/<name>` path, and it MUST reference no CDN host. The renderer MUST export one asset manifest, and each entry MUST name the staged file and its package source. The caller MUST stage each manifest entry beside the page, in the same pipeline that stages the figures.

The front door of the package MUST re-export that manifest and its entry type. An embedder that stages the assets itself reads the manifest, and it binds the asset lookup that the preview tool accepts. The front door already carries the type of that lookup, thus the value it describes belongs beside it. A hand-kept copy of the entries in an embedder would ship a build that is short one file, with nothing to say so.

#### Scenario: The page references no remote host
- **WHEN** the caller renders any valid document
- **THEN** the page holds no `src` and no `href` with an `http` or an `https` scheme

#### Scenario: The manifest and the page agree
- **WHEN** the caller renders any valid document
- **THEN** each `assets/` reference in the skeleton names one manifest entry

#### Scenario: The front door carries the manifest
- **WHEN** a consumer imports the package by its name
- **THEN** the asset manifest and its entry type resolve from that import

#### Scenario: A staged page opens with no network
- **WHEN** the caller stages the manifest and a browser opens the page offline
- **THEN** each script and each font loads from the sibling directory, and no request fails

### Requirement: The page validates as HTML and CSS
The rendered page of a valid document MUST pass an offline HTML validation with the recommended preset. A disabled rule MUST carry its reason in the test. The inline style rules MUST hold known properties with valid value syntax. The gate guards the attribute hole of the markup types, because an intrinsic element accepts an unknown attribute silently.

#### Scenario: The rendered page is valid HTML
- **WHEN** the caller renders a document with every block kind
- **THEN** an offline HTML validation of the page reports no error

#### Scenario: The inline styles are valid CSS
- **WHEN** the style rules of the page pass through the CSS validator
- **THEN** the validator reports no unknown property and no invalid value
