# report-block-model Specification

## Purpose

Define the composable block tree that a report is made of. A report is a tree of
typed blocks, not a flat list of sections. A `section` is itself a block, and it
nests. Thus a new report shape is a new arrangement of existing blocks, and not a
new type.

The block set is closed. Each block carries a stable `id` and a `kind`
discriminant, and the shape of each kind carries its own grammar. A `text` block
holds no binding field, a `metric` value slot admits one scalar reference only, and
no atom holds a child-block array. Thus a forbidden construction is unrepresentable,
and a schema parse rejects it. The grammar is the shape, and not a separate pass
that runs later.

The resolution of a binding is the concern of the `report-grounding` capability.
This capability defines which block carries a binding, and where a block can sit.

## Requirements

### Requirement: A report is a tree of typed blocks

The report document MUST be a tree of blocks, not a flat list. Each block MUST carry
a stable `id` and a `kind` discriminant. A block MUST be addressable by its `id`
across a version.

#### Scenario: A well-formed tree validates

- **WHEN** a document holds a root of blocks, each with an `id` and a `kind`
- **THEN** the block model validates the document as a tree

#### Scenario: A block without an id is rejected

- **WHEN** a block has a `kind` but no `id`
- **THEN** validation rejects the block

#### Scenario: A block without a kind is rejected

- **WHEN** a block has an `id` but no `kind`
- **THEN** validation rejects the block

### Requirement: The block set is a closed discriminated union

The `kind` field MUST be one of `section`, `text`, `claim`, `metric`, `table`,
`chart`, `figure`, or `citation`. The union MUST discriminate on `kind`. An unknown
`kind` MUST fail validation.

#### Scenario: Each of the eight kinds validates

- **WHEN** a document holds one block of each of the eight kinds, each well-formed
- **THEN** validation accepts every block

#### Scenario: A nested section validates

- **WHEN** a `section` holds another `section` that holds a `claim`
- **THEN** validation accepts the nested tree

#### Scenario: An unknown kind is rejected

- **WHEN** a block carries a `kind` that is not one of the eight
- **THEN** validation rejects the block

### Requirement: A content grammar constrains nesting

The grammar MUST define which block can hold which. A `section` MUST hold any block
kind. A `text` block and a `claim` block MUST be leaves that hold inline text only. A
`table`, a `chart`, a `figure`, and a `metric` MUST be atoms with no block children.
The root MUST hold at least one section, and a `section` MUST hold at least one
block.

The text block MUST admit an optional typed list beside its prose: an ordered flag, and an items array of non-empty inline lines, with at least one item. The list is content, not markup, and no markdown joins. A text block with a list and an empty prose is valid content.

#### Scenario: A chart inside a metric is rejected

- **WHEN** a `metric` block holds a `chart` block as a child
- **THEN** validation rejects the document for a grammar violation

#### Scenario: A claim inside a section validates

- **WHEN** a `section` holds a `claim` block
- **THEN** validation accepts the block

#### Scenario: An empty report is rejected

- **WHEN** a document holds a root with no section
- **THEN** validation rejects the document

#### Scenario: An empty section is rejected

- **WHEN** a `section` holds no block
- **THEN** validation rejects the section

#### Scenario: A text block carries a list

- **WHEN** a text block carries six ordered limitation items beside a lead sentence
- **THEN** the block validates, and the list rides the stored document

#### Scenario: An empty list refuses

- **WHEN** a text block carries a list with zero items
- **THEN** the parse fails

### Requirement: The chart grammar
A chart block MUST carry either the quick path or the composition, and never both. The quick path is one chart type with one encoding. The composition holds one or more series, optional annotations, optional axes, and an optional facet channel. A series has a form (`line`, `scatter`, `bar`, `area`, `step`) and its own column encoding. An `area` series can name a `y0` lower-bound column. A channel is a column name, or an object with the column, an optional per-row transform (`log10`, `neg_log10`, `abs`, `rank`), and an optional order. The encoding can name a `label` column for the identity of a point.

The annotations are typed members. A reference line names an axis and a constant. A reference band names an axis and two constants. Point labels name a rank rule over a named column, with a bounded count.

The chart type enum holds the base types and the presets. The base types are `bar`, `line`, `scatter`, `histogram`, `box`, `heatmap`, `pie`, `violin`, `stacked-bar`, `normalized-bar`, and `radar`. The presets are `volcano`, `manhattan`, `ma`, `km`, `pca`, `embedding`, `dotplot`, `forest`, `roc`, `qq`, `gsea`, `oncoprint`, `lollipop`, `upset`, `sankey`, and `locuszoom`. Each preset draws through its figure module.

The `upset` reads `x` for the element and `group` for the set. The `sankey` reads `x` for the source node, `y` for the target node, `value` for the flow, and an optional `group`. The `locuszoom` reads `x` for the position and `y` for the p-value. It also reads `color` for the r² with the lead variant and `label` for the variant. It reads `metric` for the recombination rate, and the track of the genes.

The annotations ride the composition alone. A preset states its own guide lines, thus the quick path needs none of its own. As a result a quick path draws no point label, and a preset over a quick path draws none either.

The bar MUST admit an optional orientation: `vertical`, the default, and `horizontal`. The quick path carries the orientation beside the chart type, and the composition carries it on the bar series form. The channels keep their data meaning in both orientations: `x` names the category column, and `y` names the value column. The `stacked-bar` and the `normalized-bar` read the orientation too. An orientation beside a quick-path type that is not a bar form is an authoring fault.

The quick path MUST admit an optional thresholds member beside the `volcano` and the `ma`. A volcano takes a pair: a positive significance value and a positive effect value. An ma takes a positive significance value alone, because it splits its rows by its `p` column. The values feed the guide lines and the preset classification, thus one declaration moves both. A thresholds member beside a type that reads none is an authoring fault. A volcano with one value and an ma with an effect value are parse failures.

The encoding MUST admit five more optional channels as content. A `color` channel names a numeric column that colors each point on a continuous scale. A `size` channel names a numeric column that sizes each point. A `low` channel and a `high` channel name the two bounds of an interval around each plotted value, and one is illegal without the other. A `facet` channel names a category column that splits one table into small multiples. A composition series MUST admit `color`, `size`, `low`, and `high` in its encoding, and a composition MUST admit `facet` beside its series. A channel that a form cannot draw is a render refusal, and never a silent drop.

The quick-path encoding MUST admit the channels of the canonical figures as content. Each one is optional, and each one names what the column holds:

- `shape` names a category column that sets the symbol of each point. The `pca` figure reads it.
- `p` names a p-value column. The `ma` figure and the `forest` figure read it.
- `censor` names the count of censored subjects at the time of the row. The `km` figure reads it.
- `risk` names the number at risk at the time of the row. The `km` figure reads it.
- `hit` names a column that holds 1 where the gene at the rank is a member of the set, else 0. The `gsea` figure reads it.
- `metric` names a second numeric column. The `gsea` figure reads it as the ranking metric at the rank of the row. The `locuszoom` figure reads it as the recombination rate at the position of the row.
- `tracks` names one to four category columns that draw as annotation strips along the x axis. The `heatmap` and the `oncoprint` read it.

A chart type that does not read one of these channels refuses it at render, and the refusal names the chart types that read it.

The chart block MUST admit an optional `statistics` list of one to four entries. Each entry holds a short label and one artifact value reference. The value is a reference and never a literal, thus a printed statistic is grounded as a metric is. The `km`, the `roc`, the `qq`, and the `gsea` figures read the statistics. A list of five entries is a parse failure.

The chart block MUST admit an optional `track` member. The track holds a whole-table binding and the names of columns of that table: `start`, `end`, `label`, and an optional `length`. The `lollipop` figure and the `locuszoom` figure read the track.

The chart block MUST admit an optional `trees` member with an `x` entry, a `y` entry, or both. Each entry holds a whole-table binding and the names of three columns of that table: `parent`, `child`, and `height`. One row of the tree table is one edge of a clustering, and the height is the height of the parent node. The `heatmap` figure reads the trees. A `trees` member with no entry is a parse failure.

The object form of a channel MUST admit an optional `orderBy` column and an optional `order` direction (`asc`, the default, and `desc`). The `transform` of the object form is optional, thus an ordered channel carries none. An `order` without an `orderBy` is a parse failure. The pair sorts the categories of the channel by the value of the named column. Thus a clustered heatmap reads the leaf order that a derived table gives. An `orderBy` on a channel that draws no category axis is a render refusal.

The chart block MUST admit an optional `focus` list of one or more category values. The renderer colors the named categories with the one focus color and mutes each other category. A focus value that no category holds is a render refusal.

The description of the chart type MUST name the channels that each base type reads. Thus an author finds each channel of a type in the schema text alone. A `pie` reads no `x` and no `y`: its `group` column names the slices, and its `value` column sizes them. The description of each preset and of each member of the canonical figures MUST name the chart types that read it. The authoring tools carry the schema to the agent, thus the description is what the agent knows about the member. The authoring grammar MUST omit the hash of the chart binding. It MUST also omit the hash of the track binding, of each tree binding, and of each statistic value.

The grammar MUST keep the fabrication holes unrepresentable. No member carries a data literal, no member carries script text, and no member carries a function. The structural tier MUST refuse a grammar column that the bound table does not hold. The wide channels, the `orderBy` column, the channels of the canonical figures, and each `tracks` column join that match. The structural tier MUST also refuse a track column that the track table does not hold. It MUST refuse a tree column that the tree table does not hold.

#### Scenario: The quick path and the composition exclude each other
- **WHEN** a chart block carries a chart type and a composition together
- **THEN** the parse fails

#### Scenario: A transform channel parses
- **WHEN** a chart series maps y onto a p-value column through `neg_log10`
- **THEN** the block parses, and the channel carries the column with the transform

#### Scenario: A data literal is unrepresentable
- **WHEN** a composition member carries an array of numbers as series data
- **THEN** the parse fails, because no member admits a data literal

#### Scenario: A grammar column outside the table refuses
- **WHEN** a series channel names a column that the bound table does not hold
- **THEN** the structural tier refuses the block before a landing

#### Scenario: A preset parses on the quick path
- **WHEN** a chart block carries the `volcano` type with an effect column, a p column, and a label column
- **THEN** the block parses on the quick path

#### Scenario: A figure preset parses on the quick path
- **WHEN** a chart block carries the `forest` type with a term column and an estimate column
- **THEN** the block parses on the quick path

#### Scenario: A volcano with declared thresholds validates
- **WHEN** the author binds a `volcano` with a significance value of `0.1` and an effect value of `1`
- **THEN** the block validates, and the thresholds ride the stored document

#### Scenario: A thresholds member on a bar refuses
- **WHEN** the author states a thresholds member beside the `bar` chart type
- **THEN** the parse fails, because the bar reads no threshold

#### Scenario: An ma takes the significance value alone
- **WHEN** the author binds an `ma` with a significance value of `0.05`
- **THEN** the block validates, and an effect value beside it fails the parse

#### Scenario: A horizontal bar validates
- **WHEN** the author binds a quick-path `bar` with the `horizontal` orientation
- **THEN** the block validates, and the orientation rides the stored document

#### Scenario: An absent orientation stays vertical
- **WHEN** a stored bar block carries no orientation
- **THEN** the block validates, and the chart renders vertical

#### Scenario: An enrichment dot plot parses
- **WHEN** the author binds a quick-path `scatter` with a `size` channel on the gene count and a `color` channel on the adjusted p
- **THEN** the block parses, and the two channels ride the stored document

#### Scenario: A lone interval bound refuses
- **WHEN** the author states a `low` channel with no `high` channel
- **THEN** the parse fails, because an interval has two bounds

#### Scenario: A channel of the canonical figures parses
- **WHEN** the author binds a `km` with a `censor` channel and a `risk` channel
- **THEN** the block parses, and the two channels ride the stored document

#### Scenario: A track list of five columns refuses
- **WHEN** the `tracks` channel names five columns
- **THEN** the parse fails, because a figure draws four strips at most

#### Scenario: The statistics parse
- **WHEN** the author binds a `km` with one statistic whose value addresses the log-rank p of a pinned table
- **THEN** the block parses, and the statistic rides the stored document

#### Scenario: Five statistics refuse
- **WHEN** a chart block carries five statistics
- **THEN** the parse fails

#### Scenario: A literal statistic is unrepresentable
- **WHEN** a statistic carries a number in place of an artifact value reference
- **THEN** the parse fails, because a statistic binds one cell

#### Scenario: A track parses
- **WHEN** the author binds a `lollipop` with a track over a domain table that names its start, end, label, and length columns
- **THEN** the block parses, and the track rides the stored document

#### Scenario: An ordered category channel parses
- **WHEN** the author binds a heatmap whose `x` channel carries `orderBy` on a leaf-order column and no transform
- **THEN** the block parses, and the order rides the stored document

#### Scenario: An order without a column refuses
- **WHEN** a channel object carries `order` and no `orderBy`
- **THEN** the parse fails

#### Scenario: A focus list parses
- **WHEN** the author binds a bar with a `focus` list of two category values
- **THEN** the block parses, and the list rides the stored document

#### Scenario: The new channels join the structural match
- **WHEN** a `color`, a `facet`, an `orderBy`, a `shape`, or a `tracks` member names a column that the bound table does not hold
- **THEN** the structural tier refuses the block before a landing

#### Scenario: An absent track column refuses
- **WHEN** the `length` of a track names a column that the track table does not hold
- **THEN** the structural tier refuses the block before a landing, and the failure names the track slot

#### Scenario: A function is unrepresentable
- **WHEN** a chart member carries a function or a formatter string
- **THEN** the parse fails, because no member admits one

#### Scenario: The schema text names the channels of each base type
- **WHEN** an agent reads the description of the chart type
- **THEN** the text names the channels of each base type, and it states that a `pie` reads no `x` and names its slices with `group`

#### Scenario: The presets of the figure extensions parse
- **WHEN** a chart block carries the `upset`, the `sankey`, or the `locuszoom` type with an `x` and a `y` channel
- **THEN** the block parses on the quick path

#### Scenario: Trees parse
- **WHEN** the author binds a `heatmap` with a sample tree on `x` and a gene tree on `y`
- **THEN** the block parses, and each tree rides the stored document

#### Scenario: An empty trees member refuses
- **WHEN** a chart block carries a `trees` member with no `x` and no `y` entry
- **THEN** the parse fails

#### Scenario: An absent tree column refuses
- **WHEN** the `height` of a tree names a column that the tree table does not hold
- **THEN** the structural tier refuses the block before a landing, and the failure names the slot of the tree

### Requirement: Each evidentiary kind carries a binding field

A `claim`, a `metric`, a `table`, a `chart`, a `figure`, and a `citation` MUST each
carry a non-empty binding field. The type MUST enforce the presence, not a lint
rule. A `text` block MUST NOT carry a binding. A `metric` MUST carry exactly one
scalar binding. The resolution of a binding is the concern of the `report-grounding`
capability.

#### Scenario: A claim with no binding is rejected

- **WHEN** a `claim` block carries no binding
- **THEN** validation rejects the block at the type level

#### Scenario: A text block with a binding is rejected

- **WHEN** a `text` block carries a binding
- **THEN** validation rejects the block

#### Scenario: A metric with two bindings is rejected

- **WHEN** a `metric` block carries two bindings
- **THEN** validation rejects the block, because a metric carries exactly one scalar binding

### Requirement: A table binding declares its column meanings

A whole-table binding MUST admit two optional maps, keyed by the column name: a meaning, and a display label. The meanings are a closed set: `p-value`, `effect`, `count`, `identifier`, and `category`. A meaning states what the column is, and it is not a format. No block carries a format field.

The field descriptions MUST teach the declaration, because the authoring tools carry the schema to the agent. A key that names no column of the artifact is ignored, because absence is a normal condition.

A whole-table binding MUST also admit an optional row bound as content: the top N rows by a named column, with `desc` as the default order. The bound rows are the table: the resolution applies the bound, thus every reader of the binding sees one bounded set. A bound whose column the artifact does not hold refuses at the structural tier.

#### Scenario: A binding declares a meaning and a label

- **WHEN** the author binds a table and declares one column as a `p-value` with a display label
- **THEN** the block validates, and the declaration rides the stored document

#### Scenario: An unknown key changes nothing

- **WHEN** a declaration names a column that the artifact does not hold
- **THEN** the render proceeds, and the stray key has no effect

#### Scenario: A bounded binding validates

- **WHEN** the author binds a table with a row bound of the top 20 rows by a p-value column
- **THEN** the block validates, and the bound rides the stored document

#### Scenario: The bound applies at resolution

- **WHEN** a bounded binding resolves against a table of 14,201 rows
- **THEN** the resolved table holds the 20 bounded rows, sorted by the named column

#### Scenario: A bound over an unknown column refuses

- **WHEN** a row bound names a column that the artifact does not hold
- **THEN** the structural tier refuses the block before a landing
