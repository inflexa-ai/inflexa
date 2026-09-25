## REMOVED Requirements

### Requirement: A considered component for each block kind
**Reason**: The chart card changes its export row into the toolbox, and a scenario of this requirement names the export row. A MODIFIED requirement must keep each scenario name, thus the requirement returns under a new name.
**Migration**: The requirement "A considered component for each kind of block" holds the same rules.

## ADDED Requirements

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

## MODIFIED Requirements

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
