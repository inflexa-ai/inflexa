## RENAMED Requirements

- FROM: `### Requirement: The claim evidence renders as markers and a provenance appendix`
- TO: `### Requirement: One reference ladder numbers every marker`

- FROM: `### Requirement: Every evidentiary binding joins the provenance appendix`
- TO: `### Requirement: Every evidentiary binding joins the References appendix`

## MODIFIED Requirements

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

### Requirement: The citation card is a bibliography entry
The citation card MUST render the short citation of its pinned record, the note of the block, and the citation key. A `pmid:` key MUST also render a PubMed link, built deterministically from the id. The link is a navigation and it loads nothing, thus the stand-alone rule holds. A key with no pinned record renders the key and the note alone, because absence is a normal condition. The marker of the card joins the one reference ladder, and the entry of the key joins the References appendix.

#### Scenario: The card renders the bibliography
- **WHEN** a citation block binds `pmid:26997480` and the pinned record carries `Hugo et al. 2016`
- **THEN** the card shows the bracket marker, the short citation, the note, and a PubMed link for the id

#### Scenario: A record-less key still renders
- **WHEN** a citation block binds a key that the record map does not hold
- **THEN** the card shows the bracket marker, the key, and the note, with no link

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

### Requirement: The table data rides a data-script asset
The renderer MUST emit the bound table of each table block as a columnar data-script payload: a columns list, row arrays, and a dictionary for a string that occurs more than one time. The payload registers under one global map, keyed by the block id, and a classic `script` tag references the asset. The payload MUST carry the pre-bound row total of the artifact beside its rows. The table markup holds the header and no data rows. The renderer MUST return the payloads beside the page string, because the renderer writes no file. The payload derivation MUST be deterministic, thus two renders of one document give byte-identical payloads.

A chart whose derived option would exceed the inline bound MUST read its rows from a registered payload, under the same global map. A chart and a table over one artifact MUST share one payload. The page script builds the series from the columns, and the label rides as a column index, not a per-point copy. A chart under the inline bound keeps its inline option, exactly as before.

The asset name MUST carry the content hash of the payload, in the content-address style of a staged figure. The table card MUST link the raw pinned bytes of its artifact as the reader download, through a relative link.

A data asset past a compression threshold near 10 MB is a later arm, and today every payload stages plain.

#### Scenario: The page holds no data rows
- **WHEN** the caller renders a document with a table of 14,201 resolved rows
- **THEN** the markup holds the table header and zero data rows, and the payload holds the rows

#### Scenario: A dense chart ships no inline rows
- **WHEN** the caller renders a chart whose option would exceed the inline bound
- **THEN** the inline option holds no per-row data, and the chart reads the registered payload

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
