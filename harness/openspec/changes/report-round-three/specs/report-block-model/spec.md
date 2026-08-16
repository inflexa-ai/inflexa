## MODIFIED Requirements

### Requirement: The chart grammar
A chart block MUST carry either the quick path or the composition, and never both. The quick path is one chart type with one encoding. The composition holds one or more series, optional annotations, and optional axes. A series has a form (`line`, `scatter`, `bar`, `area`, `step`) and its own column encoding. An `area` series can name a `y0` lower-bound column. A channel is a column name, or a column with a per-row transform (`log10`, `neg_log10`, `abs`, `rank`). The encoding can name a `label` column for the identity of a point.

The annotations are typed members. A reference line names an axis and a constant. A reference band names an axis and two constants. Point labels name a rank rule over a named column, with a bounded count. The chart type enum holds the seven base types and the presets `volcano`, `manhattan`, `ma`, and `km`.

The annotations ride the composition alone. A preset states its own guide lines, thus the quick path needs none of its own. As a result a quick path draws no point label, and a preset over a quick path draws none either.

The bar MUST admit an optional orientation: `vertical`, the default, and `horizontal`. The quick path carries the orientation beside the chart type, and the composition carries it on the bar series form. The channels keep their data meaning in both orientations: `x` names the category column, and `y` names the value column. An orientation beside a quick-path type that is not a bar is an authoring fault.

The quick path MUST admit an optional thresholds member beside a preset type that reads thresholds: a positive significance value, and a positive effect value. The values feed the guide lines and the preset classification, thus one declaration moves both. A thresholds member beside a type that reads none is an authoring fault.

The grammar MUST keep the fabrication holes unrepresentable. No member carries a data literal, and no member carries script text. The structural tier MUST refuse a grammar column that the bound table does not hold.

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
- **THEN** the block validates, and the chart renders exactly as before
