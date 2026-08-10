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

### Requirement: The page navigation
The page MUST hold a left-side navigation with one anchor for each top-level section. Each anchor MUST target its section by the section block id.

#### Scenario: The navigation lists the top-level sections
- **WHEN** the caller renders a document with three top-level sections
- **THEN** the navigation holds three anchors, and each anchor targets its section id

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

### Requirement: The claim evidence renders as markers and a reference list
A claim MUST render its prose with evidence markers, and the references MUST list at the end of the page. The markers number by first appearance. An identical reference MUST appear one time in the list. Reference identity is the full reference value after a stable serialization, thus two references are identical only when every field matches. A derivation reference MUST list as its operation with its two pinned inputs, each named by path and locator.

#### Scenario: Two claims share one reference
- **WHEN** the caller renders two claim blocks that carry the same reference
- **THEN** both claims show the same marker number, and the list holds one entry for it

### Requirement: The page holds no local asset reference
The skeleton MUST inline the style rules, and it MUST reference each script and font through the pinned CDN constants with their integrity hashes. The output MUST hold no relative asset path.

#### Scenario: The output stands alone beside the CDN
- **WHEN** the caller renders any valid document
- **THEN** the page holds no `src` or `href` that points at a local file

### Requirement: The page validates as HTML and CSS
The rendered page of a valid document MUST pass an offline HTML validation with the recommended preset. A disabled rule MUST carry its reason in the test. The inline style rules MUST hold known properties with valid value syntax. The gate guards the attribute hole of the markup types, because an intrinsic element accepts an unknown attribute silently.

#### Scenario: The rendered page is valid HTML
- **WHEN** the caller renders a document with every block kind
- **THEN** an offline HTML validation of the page reports no error

#### Scenario: The inline styles are valid CSS
- **WHEN** the style rules of the page pass through the CSS validator
- **THEN** the validator reports no unknown property and no invalid value
