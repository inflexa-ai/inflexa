# Spec Delta

## MODIFIED Requirements

### Requirement: The chart grammar
A chart block MUST carry either the quick path or the composition, and never both. The quick path is one chart type with one encoding. The composition holds one or more series, optional annotations, optional axes, and an optional facet channel. A series has a form (`line`, `scatter`, `bar`, `area`, `step`) and its own column encoding. An `area` series can name a `y0` lower-bound column. A channel is a column name, or an object with the column, an optional per-row transform (`log10`, `neg_log10`, `abs`, `rank`), and an optional order. The encoding can name a `label` column for the identity of a point.

The annotations are typed members. A reference line names an axis and a constant. A reference band names an axis and two constants. Point labels name a rank rule over a named column, with a bounded count. The chart type enum holds the eleven base types and the presets `volcano`, `manhattan`, `ma`, and `km`. The base types are `bar`, `line`, `scatter`, `histogram`, `box`, `heatmap`, `pie`, `violin`, `stacked-bar`, `normalized-bar`, and `radar`.

The annotations ride the composition alone. A preset states its own guide lines, thus the quick path needs none of its own. As a result a quick path draws no point label, and a preset over a quick path draws none either.

The bar MUST admit an optional orientation: `vertical`, the default, and `horizontal`. The quick path carries the orientation beside the chart type, and the composition carries it on the bar series form. The channels keep their data meaning in both orientations: `x` names the category column, and `y` names the value column. The `stacked-bar` and the `normalized-bar` read the orientation too. An orientation beside a quick-path type that is not a bar form is an authoring fault.

The quick path MUST admit an optional thresholds member beside a preset type that reads thresholds: a positive significance value, and a positive effect value. The values feed the guide lines and the preset classification, thus one declaration moves both. A thresholds member beside a type that reads none is an authoring fault.

The encoding MUST admit five more optional channels as content. A `color` channel names a numeric column that colors each point on a continuous scale. A `size` channel names a numeric column that sizes each point. A `low` channel and a `high` channel name the two bounds of an interval around each plotted value, and one is illegal without the other. A `facet` channel names a category column that splits one table into small multiples. A composition series MUST admit `color`, `size`, `low`, and `high` in its encoding, and a composition MUST admit `facet` beside its series. A channel that a form cannot draw is a render refusal, and never a silent drop.

The object form of a channel MUST admit an optional `orderBy` column and an optional `order` direction (`asc`, the default, and `desc`). The `transform` of the object form is optional, thus an ordered channel carries none. An `order` without an `orderBy` is a parse failure. The pair sorts the categories of the channel by the value of the named column. Thus a clustered heatmap reads the leaf order that a derived table gives. An `orderBy` on a channel that draws no category axis is a render refusal.

The chart block MUST admit an optional `focus` list of one or more category values. The renderer colors the named categories with the one focus color and mutes each other category. A focus value that no category holds is a render refusal.

The grammar MUST keep the fabrication holes unrepresentable. No member carries a data literal, no member carries script text, and no member carries a function. The structural tier MUST refuse a grammar column that the bound table does not hold. The new channels and the `orderBy` column join that match.

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

#### Scenario: A volcano with declared thresholds validates
- **WHEN** the author binds a `volcano` with a significance value of `0.1` and an effect value of `1`
- **THEN** the block validates, and the thresholds ride the stored document

#### Scenario: A thresholds member on a bar refuses
- **WHEN** the author states a thresholds member beside the `bar` chart type
- **THEN** the parse fails, because the bar reads no threshold

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
- **WHEN** a `color` channel, a composition `facet`, or an `orderBy` names a column that the bound table does not hold
- **THEN** the structural tier refuses the block before a landing

#### Scenario: A function is unrepresentable
- **WHEN** a chart member carries a function or a formatter string
- **THEN** the parse fails, because no member admits one
