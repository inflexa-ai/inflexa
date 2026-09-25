# Spec Delta

## ADDED Requirements

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

A module MUST state the members of the block that it reads: the channels, the statistics, the track, and the focus. The derivation MUST refuse each other member before the module runs, and the problem names the member. A module is a pure function of the block, the rows, and its context, and its option holds no function.

The context MUST give the module the declarations of the bound table, the statistics, the track, and the page text size. Each statistic comes with its label, its value, and its shown text. The number helper formats the shown text in the kind of its locator column. The context MUST also give the composition machinery. Thus a dense figure reads the shared payload past the inline bound, as a composition does.

The page builds each series of the payload from the cells of the table. Thus a series that reads the payload MUST give on the page the items of the inline option. A module that changes the items of its composition output MUST keep those rows inline, because the page does not do the change.

A chart type with no module MUST refuse the members of the canonical figures: `shape`, `p`, `censor`, `risk`, `hit`, `metric`, `tracks`, the statistics, and the track. The refusal names the chart types that read the member. A composition MUST refuse the statistics and the track, because it draws one grid over one table. A value entry that lacks a statistic or the track that the block declares MUST give a `missing-value` problem.

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
- A name MUST NOT cover another name, a leader line, or a point, and a leader line MUST NOT cross a name or a point. The derivation measures each place at the plot of the single-column export, which holds the smallest plot beside the largest text of each render. Where no place is free, the name takes the place that covers the fewest points and no name. A name that finds no place clear of the other names draws nothing.
- The names ride one series after the points, and that series keeps its rows inline. Thus a dense volcano reads the payload, and the names draw over the points.
- The effect axis is symmetric around zero. Each end is the round number at or past the largest effect and the effect threshold.
- The p axis starts at zero.
- A row with no p-value draws no point, and it counts in no category.
- A stored p-value of 0 states that the true p sits under the resolution of the test, and `neg_log10` gives it no value. Such a row draws an upward triangle at the largest finite −log10 p of the table. Where no finite p passes the significance line, the triangle draws one unit over the line. The effect of the row selects its category, as for each other row. The row counts in that category, and it can show its name.
- The label of the p guide prints the threshold as a p-value column prints it, as a power of ten, for example `p 1 × 10⁻⁷`.

The figure computes these summaries from the rows:

- The count of each category: the count of the rows that the split puts in it.
- The labeled rows: the signal rows with a name, in the order of the p-value, at most ten. A stored zero comes first. A tie keeps the order of the rows.
- The place of each name: the first free place in the order of the sides and the steps, in the order of the labeled rows.

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
- A name prints only when its middle sits at least 2.5% of the position span past the middle of the last printed name. The first name always prints. Thus two names never print on top of each other. On a plot too narrow for the gap, the runtime also hides a name that overlaps another.
- A guide line marks the genome-wide threshold 5e-8. Its label `p 5 × 10⁻⁸` sits over the line at the right end, inside the plot. Thus it stays clear of the axis and of the chromosome names. The box of the label is kept free when the lead names find their places, thus no lead name covers it. A second guide line marks the suggestive threshold 1e-5 with no label.
- The ten most significant lead variants show the text of the `label` column, one for each chromosome at most. The derivation places each name as the volcano places its names, over its peak first, then at the right and at the left. A name over a peak near a side edge moves along the position axis until it fits inside the plot.
- A paper prints a Manhattan plot across the page, thus the names measure their places at the plot of the double-column export. The single-column file can crowd them.
- The position axis spans the drawn positions. The p axis starts at zero, and it holds the genome-wide line.

The figure computes these summaries from the rows of each chromosome:

- The middle: the mean of the smallest and the largest drawn position.
- The lead variant: the row with the smallest p-value under 5e-8 that carries a name. A stored zero is the smallest p-value. A tie keeps the row at the smaller position.
- The labeled leads: the ten leads with the smallest p-value over the genome. A tie keeps the lead at the smaller position.
- The place of each lead name, by the rule of the volcano names.

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
- **WHEN** the middle of chromosome 2 sits 1.5% of the span past the middle of chromosome 1
- **THEN** the names `1` and `3` print, and the name `2` does not

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
A `heatmap` chart MUST draw a matrix of one value over each pair of two category columns, as pheatmap and ComplexHeatmap draw it. The figure reads the `x`, `y`, and `value` channels, and the optional `tracks` channel.

- The y axis lists its categories top-down. Each axis follows the `orderBy` of its channel, for example the leaf order of a clustering, or the order of the rows.
- A value column that crosses zero, for example a z-score, takes the diverging scale centered on zero. Each other column takes the sequential scale.
- A distance matrix takes the sequential scale, whose dark end is the low value. Thus the diagonal of zero distance draws dark, as the DESeq2 sample-distance figure draws it.
- The cells stand apart by a white gap of 1 pixel, and the axes draw no line and no tick.
- When the x axis holds more than 40 categories, the x labels hide, and the axis title states the count, for example `sample (n = 41)`.
- pheatmap names each row. The default body holds a row of 16 px for a few rows alone. Thus a matrix of more rows states a taller chart body, up to the largest body. A y label that overlaps its neighbor hides. This occurs past the largest body, and in a column export whose rows are shorter than a line of text.

Each column of `tracks` MUST draw one strip of category colors over the matrix, in the order of the x axis. Each strip names its column at its left. Each strip has a legend of its own over the strips, with the title of its column. The legends take a band of their own: one line of 24 px for each legend, and a gap of 14 px over the strips. The categories of all strips take one palette in order, thus no two strips share a color. A track column holds one value for each x category.

The figure computes one lookup: the category of each track at each x category.

The figure MUST refuse these blocks, and the problem names the cause:

- a repeated pair of an x category and a y category.
- a track column with two values for one x category.
- a count of cells past the slot bound.
- a transform on the `x` or the `y` channel.

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

## MODIFIED Requirements

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

### Requirement: The chart exports as a publication file
The renderer MUST make two SVG files for each chart block through the server-side render of the chart runtime: one at the single column of 89 × 67 mm, and one at the double column of 183 × 92 mm. Each SVG renders the option of the chart with its full rows, in the same theme, at the print text size. It holds no toolbox, no tooltip, and no animation. The root element states the size in millimeters, and the view box keeps the pixel space. The bytes MUST be deterministic: two renders of one document give byte-identical files, and the renderer renumbers each instance-scoped token of the chart runtime in order of appearance. The axis jitter of the chart runtime places a point at random where it finds no free place. Thus each export draws with one fixed seeded sequence in place of the random source, and two renders place each point at one place. Each SVG rides the render result as a staged data asset with a content-addressed name, and never as a page script. The caller stages it beside the page.

The export MUST carry a bound. A chart whose plotted point count passes the crowd row count gets no SVG, and the export row states that the PNG serves it. The count reads the drawn coordinates: an empty slot counts nothing, a radar counts one coordinate for each indicator, and a violin outline counts each vertex that it draws.

The chart card MUST carry an export row under the chart body: a link to each SVG, and one control for each PNG. The page MUST make each PNG on click from an offscreen canvas of the chart runtime, with the same option and theme. The single column and the double column render at 300 DPI at the print text size. The 16:9 slide renders at 1920 × 1080 pixels at the slide text size. The export row is hidden in print.

A chart body taller than the default body of 400 px MUST grow the height of each column export in the same ratio. The column keeps its width. The height stops at 170 mm, the full page depth of the Nature guide. The root of the SVG and each PNG control state the grown height. The slide keeps its 16:9 box.

The export MUST scale each text of the figure to the export text size. This includes the text of each child of a graphic group, for example the size legend. The panels of a facet end over the band of a bottom legend, and the band holds the legend lines that the export width gives. The x title of the facet sits on that band.

#### Scenario: A taller body grows the column height
- **WHEN** the caller renders a facet of two panel rows, with a body of 760 px
- **THEN** the single-column SVG states a height of 127 mm, and the single-column PNG control states a height of 481 px

#### Scenario: The size legend prints at the export text size
- **WHEN** the export draws a dot plot with a size legend at the single column
- **THEN** the title and the values of the size legend read at 9.33 px

#### Scenario: A facet legend of three lines keeps its band
- **WHEN** the export draws a facet of two panels with a legend of eight cell types at the single column
- **THEN** the legend wraps into three lines, and the panels and the x title end over the band of those lines

#### Scenario: The SVG assets ride the render
- **WHEN** the caller renders a document with one chart block
- **THEN** the data assets hold two SVG entries for that block, and the page holds no script tag for them. The export row links both by their relative paths

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
- **THEN** the data assets hold no SVG for it, and the export row states that the PNG serves the chart

#### Scenario: The page makes the PNG
- **WHEN** a reader clicks the single-column PNG control
- **THEN** the page script draws the chart offscreen at 1050 pixels wide and downloads the PNG

#### Scenario: The slide PNG is 16:9
- **WHEN** a reader clicks the slide PNG control
- **THEN** the page script draws the chart offscreen at 1920 × 1080 pixels and downloads the PNG

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
