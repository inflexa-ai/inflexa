# report-design-system Specification

## Purpose
The visual identity that a block document renders through. It covers the tokens, the typography, the per-kind components, the page architecture, the print form, and the evolution rule.

## Requirements

### Requirement: The page carries the identity tokens
The inline style sheet MUST define the identity tokens as CSS custom properties. The set covers the primary scale, the neutral roles, the data-visualization colors, the semantic tag pairs, and the stat accents. The body font MUST be Space Grotesk. Each label, each badge, each table header, and each data value MUST render in IBM Plex Mono. A heading MUST NOT render in the mono font. The text inside a chart is the one exception: it renders in the journal sans stack of the chart theme, because a figure keeps its own typography on the page and in the paper.

#### Scenario: The token sheet is present
- **WHEN** the caller renders any valid document
- **THEN** the inline style sheet defines the primary scale and the data-visualization colors as custom properties

#### Scenario: A table header renders in the mono font
- **WHEN** the caller renders a table block
- **THEN** the table header carries the mono font form, in uppercase

#### Scenario: The chart text keeps its own font
- **WHEN** the caller renders a chart block
- **THEN** the chart theme names the journal sans stack, and the page fonts do not reach the chart text

### Requirement: The page architecture
The page MUST hold these regions in this order: the hero, one full-bleed band for each top-level section, the reference band, and the dark footer. The hero MUST show a constant eyebrow and the document title. The band backgrounds MUST alternate between white and slate, and each band MUST carry a texture. The left navigation MUST shift the page body on a large viewport.

One centered content column MUST hold every block kind, and the prose MUST fill that column completely. No inner measure caps the prose below the column width.

The navigation brand MUST link to the Inflexa site, and the footer MUST read `Powered by Inflexa`. No page surface names the internal engine.

#### Scenario: The bands alternate
- **WHEN** the caller renders a document with three top-level sections
- **THEN** the second band carries the slate background, and the first and the third carry the white background

#### Scenario: The hero shows the title
- **WHEN** the caller renders a document with the title "Study X"
- **THEN** the hero shows "Study X" as the display heading, under the eyebrow

#### Scenario: The footer closes the page
- **WHEN** the caller renders any valid document
- **THEN** the dark footer renders after the reference band

#### Scenario: The blocks share one centered column
- **WHEN** the caller renders a document with prose, a table, and a chart
- **THEN** the three blocks share one content column, and no prose rule caps a narrower measure

#### Scenario: The page carries the identity wording
- **WHEN** the caller renders any valid document
- **THEN** the navigation brand links to the Inflexa site, the footer reads `Powered by Inflexa`, and no surface names the engine

### Requirement: The geometric identity rules
A data card MUST hold square corners with the corner accents. The theme MUST stay light: white and slate surfaces, with dark only in the footer.

#### Scenario: A figure card keeps the square corners
- **WHEN** the caller renders a figure block
- **THEN** its card carries the corner accents and no border radius

#### Scenario: A chart card keeps the square corners
- **WHEN** the caller renders a chart block
- **THEN** its card carries the corner accents and no border radius

### Requirement: The print form and the reduced motion
The style sheet MUST hold a print block that hides each texture, shows each fade-in element, and turns the footer light. The style sheet MUST collapse each animation duration under `prefers-reduced-motion: reduce`.

#### Scenario: The print block is present
- **WHEN** the caller renders any valid document
- **THEN** the style sheet holds a `@media print` block that hides the textures and shows each fade-in element

#### Scenario: The reduced-motion block is present
- **WHEN** the caller renders any valid document
- **THEN** the style sheet holds a `prefers-reduced-motion` block that collapses the durations

### Requirement: The design evolves through the design source
The design MUST live in the renderer source: the design sheet module and the views. The repository MUST hold one fixture document that covers every block kind, with the publication look. The fixture MUST hold one chart for the coverage of the chart block. The chart forms MUST live in the figure gallery, and never in the fixture. A package script MUST render the fixture to a file and print the path, thus a person examines a design edit directly.

#### Scenario: The fixture covers every kind
- **WHEN** the fixture document renders
- **THEN** the page holds each of the eight block kinds, and the validity gates pass

#### Scenario: The fixture covers every chart form
- **WHEN** a reviewer reads the fixture module and the gallery module
- **THEN** the fixture holds one chart block and no synthetic table, and the gallery holds one chart of each chart form

#### Scenario: The script renders the fixture
- **WHEN** a person runs the fixture script
- **THEN** the script writes the fixture page with its assets, and it prints the path

### Requirement: A block kind names content, never presentation
The block grammar MUST name content and its grounding, and it MUST NOT name presentation. A presentation improvement MUST land in the renderer, not in the grammar. A new block kind is correct only when the agent must supply content that no current kind carries, with its own binding shape. The grammar MUST NOT gain a style field.

#### Scenario: A presentation ask changes no grammar
- **WHEN** a report needs a donut form in place of a pie form
- **THEN** the change lands in the renderer, and the block grammar does not change

### Requirement: The lineage popover is a component of the design system
The popover MUST take each color, each space value, and each type value from the design tokens. The control is one inline stroke SVG on the 16px grid, drawn in the view, muted at rest and primary on hover. The rail marks the pinned artifact with the primary tint, a raw input with the terminal tint, and a producer row with the mono type. The design fixture MUST cover the popover control on a grounded block. Each new CSS class of the popover MUST have an emitting view.

#### Scenario: The fixture covers the popover
- **WHEN** the design fixture renders
- **THEN** one grounded block shows the branch-glyph control, with a document asset that gives it a chain

#### Scenario: No orphan class
- **WHEN** the design sheet gains a popover class
- **THEN** a view emits that class in the rendered page

### Requirement: The chart theme is a publication figure
The chart theme MUST render each chart as a journal figure on the page and in the export. The left axis line and the bottom axis line are strong and dark. There is no top axis line, no right axis line, and no grid line. The legend carries no frame, and the tooltip stays for the page. The chart text renders in the journal sans stack (Helvetica, Arial, then a generic sans-serif), in a near-black color. The palette is colorblind-safe, and no two hues differ by a red-green difference alone. The first hue is the focus color. The muted color serves the null category and each category outside a focus.

Each bar item MUST carry a value label when the chart holds twelve items or fewer, as the `report-render` rule states. A bar that carries an interval carries no value label, because the whisker stands where the label would stand. The label text is the shown form of the number helper, as a static per-item string. Thus the label reads as the card beside it reads, and the plotted value stays the cell.

The theme MUST take no code, no text, no palette value, and no image from figures4papers. It follows the principles alone.

#### Scenario: The axes read as a figure
- **WHEN** the caller renders any chart block
- **THEN** the theme shows the left and the bottom axis lines, hides the split lines, and frames no legend

#### Scenario: The palette is colorblind-safe
- **WHEN** a reviewer reads the theme palette
- **THEN** each hue comes from a colorblind-safe set, and no two hues differ by a red-green difference alone

#### Scenario: A small bar chart labels its values
- **WHEN** the caller derives a bar over six categories
- **THEN** each item carries a static label with the shown form of its value

#### Scenario: A busy bar chart carries no labels
- **WHEN** the caller derives a bar over thirty categories
- **THEN** no item carries a value label

### Requirement: The figure gallery draws each chart type from public data
The repository MUST hold a figure gallery: one report document that draws each chart type of the grammar from a table of public data. The gallery document MUST hold one section for each field: bulk RNA-seq, gene set enrichment, single cell, clinical outcomes, genome-wide association, and somatic mutations. Each chart MUST have a text block before it that tells the reader what the chart shows. The caption of each chart MUST name its dataset and its license.

The gallery MUST hold these uses of the dendrogram and of the three later figures:

- The heatmap of the top genes binds a tree on each axis: the sample tree on `x` and the gene tree on `y`.
- The heatmap of the sample distances binds one sample tree on both axes.
- An UpSet plot shows the co-mutation of the most mutated genes of TCGA LAML.
- A Sankey diagram follows the LAML patients from the FAB subtype to the FLT3 status, and then to the vital status.
- A LocusZoom panel shows the FTO locus of the body mass index study. It binds the track of the genes and declares the label of the position axis.

A clustered heatmap carries its dendrograms, thus the tree replaces the `orderBy` of its axis. The gallery holds no second heatmap of the same table.

Each block MUST use the report grammar alone, as the report agent writes it. Each statistic, each track, and each tree MUST bind as a reference. The gallery MUST NOT hold a data literal.

A loader MUST read each table that the document binds, and it MUST parse each cell as text, as the production resolver parses a CSV. The loader MUST run the resolution pass of the preview over an in-memory snapshot, and it MUST bridge the resolved values into the render values. Thus a pin that does not match its file, an absent column, and a statistic that does not resolve each fail the load.

The package script `design:gallery` MUST render the gallery into a stable directory under the system temp directory. The script MUST stage each page asset and each data asset beside the page, and it MUST print the path of the page. The build MUST NOT emit the gallery.

The repository does not hold the gallery tables. When the tables are absent, `design:gallery` MUST print the command `bun run gallery:data` and exit with a status that is not zero. Each test that reads the tables MUST skip, and the name of its group MUST give the same command. Each test that reads only the manifest or the document MUST run.

A test MUST hold these gates:

- The gallery holds one chart of each chart type that the contract declares and that the renderer draws.
- The document validates, each reference resolves, and the prose carries no warning.
- The gallery renders with no problem, and two renders give the same page and the same data assets.
- The option of each preset holds the canonical elements of its field, from the real rows.

#### Scenario: A new chart type needs a gallery chart
- **WHEN** the contract gains a chart type that the renderer draws, and the gallery holds no chart of it
- **THEN** the coverage gate of the gallery test fails

#### Scenario: A stale pin fails the load
- **WHEN** a table of the gallery changes, and the pin of the document stays
- **THEN** the load fails with `hash-mismatch`, and the failure names the block

#### Scenario: The gallery renders the same bytes
- **WHEN** the test renders the gallery two times
- **THEN** the two pages are equal, and each data asset is equal

#### Scenario: A preset shows its canonical elements
- **WHEN** the test derives the Kaplan-Meier chart of the gallery
- **THEN** the option holds a step line and censor marks for each group, the number-at-risk table, and the log-rank p

#### Scenario: A clustered heatmap takes the leaf order of its trees
- **WHEN** the test derives the heatmap of the top genes
- **THEN** each axis holds the leaf order that the order columns of the run give, and each tree draws one elbow for each edge

#### Scenario: The later figures show their canonical elements
- **WHEN** the test derives the UpSet plot, the Sankey diagram, and the LocusZoom panel of the gallery
- **THEN** the UpSet plot counts each tumor in one intersection, and it sorts the intersections and the sets by size
- **AND** the Sankey diagram keeps the node order of the table, and each stage takes the palette from its start
- **AND** the LocusZoom panel holds the five r² bins, the lead diamond, the recombination axis, and gene lanes with no overlap

#### Scenario: The script renders the gallery
- **WHEN** a person runs `design:gallery`
- **THEN** the script writes the gallery page with its assets, and it prints the path

#### Scenario: The gallery tables are absent
- **WHEN** a person runs the gallery test or `design:gallery` in a checkout with no gallery tables
- **THEN** each test that reads the tables skips, and the name of its group gives `bun run gallery:data`
- **AND** the tests of the manifest and of the document run
- **AND** `design:gallery` prints `bun run gallery:data` and exits with a status that is not zero

### Requirement: The gallery states the source and the license of each table
The gallery tables MUST sit under `gallery/data/<field>/`, and their total MUST stay under 4 MB. The repository MUST NOT hold the tables, and an ignore rule of the harness MUST keep them out of Git. A dense table MUST thin by the rule of its field, with a fixed seed where the rule samples:

- A single-cell embedding keeps a sample of equal size from each condition.
- A Manhattan table keeps each variant with a p under 0.001, and a sample of the other variants.
- A QQ table keeps the strongest points and an evenly spaced subset along the expected axis, with the band columns.
- A running-score table keeps each hit rank, each local extremum, and each k-th rank of each set.

A table that a volcano binds MUST stay whole. A copy can drop a column that no chart reads, and the manifest MUST name the cut.

The manifest MUST give these facts for each table:

- the dataset and its citation.
- the license: the name, the URL, and a quote of the license text.
- the source URLs.
- the derivation and the thinning rule.
- the count of rows, the count of bytes, and the SHA-256 of the bytes.

The derivation scripts MUST sit under `gallery/derive/`. No build and no test runs them.

The package script `gallery:data` MUST rebuild the tables from the public sources. The script MUST do these steps in this sequence:

1. Download each raw input into a work directory. Stop each download over 500 MB.
2. Compare the SHA-256 of each download with the value that the script pins. A difference MUST fail the run.
3. Run each derivation script, and then thin the derived tables.
4. Compare the rows, the bytes, the SHA-256, and the thinning rule of each table with its manifest entry. A difference MUST fail the run.
5. Replace the data directory with the tables.

Each source URL of the script MUST name a fixed version of its source, thus a second run gets the same bytes. A second run MUST NOT download a raw file again when its SHA-256 matches. An environment variable MUST set the work directory, and another MUST set the data directory. Each derivation script MUST give the same bytes on each run, thus it MUST set a fixed seed where it samples.

#### Scenario: The manifest agrees with the files
- **WHEN** the test reads the manifest and each table
- **THEN** each table has one entry, and the rows, the bytes, and the SHA-256 of each entry match the file
- **AND** the SHA-256 of each entry matches the pin of the document

#### Scenario: The script rebuilds the tables
- **WHEN** a person runs `gallery:data` in a checkout with no gallery tables
- **THEN** the script writes each table of the manifest, and each table matches its manifest entry byte for byte

#### Scenario: A rebuilt table does not match the manifest
- **WHEN** `gallery:data` makes a table whose SHA-256 is not the SHA-256 of its manifest entry
- **THEN** the script names the table and fails, and the data directory does not change

#### Scenario: A source changes
- **WHEN** a download does not match the SHA-256 that the script pins
- **THEN** the script fails before it runs a derivation script

#### Scenario: The data stays under the bound
- **WHEN** the test adds the bytes of each table
- **THEN** the total is under 4 MB

#### Scenario: Each table carries its license
- **WHEN** the test reads each entry of the manifest
- **THEN** the entry holds a citation, a license name, a license URL, a license quote, a source URL, a derivation, and a thinning rule

### Requirement: A considered component for each kind of block
The renderer MUST give each block kind its identity component:

- A `text` block renders as prose that fills the content column.
- A `claim` block renders as prose with the styled evidence markers.
- A `metric` block renders as a stat card with a mono value and an accent. The value MUST stay inside the card: the card carries an overflow guard, thus a long value can never paint past the card edge.
- A consecutive run of `metric` siblings renders as one responsive grid.
- A `table` block renders as a data table inside a corner-accent card. The card carries the sort headers, the filter input, and the row-cap toggle.
- A `chart` block renders as a corner-accent card with a mono title line and a chart body. The chart body carries the toolbox at its top right, and the card holds the download menu of the toolbox. The card holds no export row under the body. The body takes the height that its figure states, up to a cap. The height is the default, the height of the facet panel rows, or a height from the row count of a tall figure. A square figure states its width, and the body centers at that width. The card carries no window chrome, no dots, no badge, and no hover raise, because a report is a document and not an application window.
- The title line of a chart card carries a quiet download control at its right end, and the control opens the same menu.
- The download menu takes the design tokens: square corners, the card surface and border, and entries in the mono uppercase labels of the card title. The data view of the toolbox takes the same mono labels, and its close control has square corners.
- A `figure` block renders as a corner-accent card with its caption.
- A `citation` block renders as a card in the reference form.
- A `section` block renders as a heading by depth.

#### Scenario: Consecutive metrics form one grid
- **WHEN** the caller renders a section with three metric blocks in a row
- **THEN** one grid holds the three stat cards

#### Scenario: A lone metric stays a card
- **WHEN** the caller renders a section with one metric block between two text blocks
- **THEN** the metric renders as one stat card, and no grid wraps the text

#### Scenario: A chart card carries no window costume
- **WHEN** the caller renders a chart block
- **THEN** the title line sits over the card, and the card holds the chart body with no dot, no badge, and no raise

#### Scenario: A chart card carries the download menu
- **WHEN** the caller renders a chart block
- **THEN** the card holds the chart body, the option script, and the closed download menu, and it holds no row of export controls
- **AND** the title line holds a download control that the keyboard reaches, and the control opens the same menu

#### Scenario: A faceted chart grows its body
- **WHEN** the caller renders a chart block whose facet gives two rows of panels
- **THEN** the chart body carries the height of two panel rows

#### Scenario: A tall figure grows its body
- **WHEN** the caller renders an oncoprint of twenty genes
- **THEN** the chart body carries a height that prints each gene name, and the height stays under the cap

#### Scenario: A long metric value stays inside its card
- **WHEN** the caller renders a metric whose formatted value still runs wide on a narrow card
- **THEN** the value stays inside the card bounds, and no character paints past the card edge

#### Scenario: The table carries the enhancer controls
- **WHEN** the caller renders a table block
- **THEN** the card holds the sort headers and the filter input, in the identity styles of the design source
