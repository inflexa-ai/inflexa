## ADDED Requirements

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

## MODIFIED Requirements

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
