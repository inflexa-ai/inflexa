# Spec Delta

## MODIFIED Requirements

### Requirement: A considered component for each block kind
The renderer MUST give each block kind its identity component:

- A `text` block renders as prose that fills the content column.
- A `claim` block renders as prose with the styled evidence markers.
- A `metric` block renders as a stat card with a mono value and an accent. The value MUST stay inside the card: the card carries an overflow guard, thus a long value can never paint past the card edge.
- A consecutive run of `metric` siblings renders as one responsive grid.
- A `table` block renders as a data table inside a corner-accent card. The card carries the sort headers, the filter input, and the row-cap toggle.
- A `chart` block renders as a corner-accent card with a mono title line, a chart body, and an export row. The body takes the height that its figure states, up to a cap. The height is the default, the height of the facet panel rows, or a height from the row count of a tall figure. A square figure states its width, and the body centers at that width. The card carries no window chrome, no dots, no badge, and no hover raise, because a report is a document and not an application window.
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

#### Scenario: A chart card carries the export row
- **WHEN** the caller renders a chart block
- **THEN** the card holds the export row under the chart body, with the SVG links and the PNG controls

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

## ADDED Requirements

### Requirement: The figure gallery draws each chart type from public data
The repository MUST hold a figure gallery: one report document that draws each chart type of the grammar from a table of public data. The gallery document MUST hold one section for each field: bulk RNA-seq, gene set enrichment, single cell, clinical outcomes, genome-wide association, and somatic mutations. Each chart MUST have a text block before it that tells the reader what the chart shows. The caption of each chart MUST name its dataset.

Each block MUST use the report grammar alone, as the report agent writes it. Each statistic and each track MUST bind as a reference. The gallery MUST NOT hold a data literal.

A loader MUST read each table that the document binds, and it MUST parse each cell as text, as the production resolver parses a CSV. The loader MUST run the resolution pass of the preview over an in-memory snapshot, and it MUST bridge the resolved values into the render values. Thus a pin that does not match its file, an absent column, and a statistic that does not resolve each fail the load.

The package script `design:gallery` MUST render the gallery into a stable directory under the system temp directory. The script MUST stage each page asset and each data asset beside the page, and it MUST print the path of the page. The build MUST NOT emit the gallery.

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

#### Scenario: The script renders the gallery
- **WHEN** a person runs `design:gallery`
- **THEN** the script writes the gallery page with its assets, and it prints the path

### Requirement: The gallery states the source and the license of each table
The gallery tables MUST sit under `gallery/data/<field>/`, and their total MUST stay under 4 MB. A dense table MUST thin by the rule of its field, with a fixed seed where the rule samples:

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
- the count of rows and the count of bytes.

The derivation scripts MUST sit under `gallery/derive/` as reference material. No build and no test runs them.

#### Scenario: The manifest agrees with the files
- **WHEN** the test reads the manifest and each table
- **THEN** each table has one entry, and the rows and the bytes of each entry match the file

#### Scenario: The data stays under the bound
- **WHEN** the test adds the bytes of each table
- **THEN** the total is under 4 MB

#### Scenario: Each table carries its license
- **WHEN** the test reads each entry of the manifest
- **THEN** the entry holds a citation, a license name, a license URL, a license quote, a source URL, a derivation, and a thinning rule
