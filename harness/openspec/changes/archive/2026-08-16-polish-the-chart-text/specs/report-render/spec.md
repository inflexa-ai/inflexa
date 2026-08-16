# Delta: report-render

## ADDED Requirements

### Requirement: The chart text reads for a reader

A preset MUST fill its semantic axis titles. A volcano titles "log2 fold change" and "−log10(p)", and a manhattan titles "−log10(p)" on its y axis. The precedence, most specific first: an agent axes title, a declared column label, the preset title, then the raw or derived name.

The category value `ns` on a preset-expanded chart MUST take the muted chart color of the design source. Thus the significant categories carry the color, and the null category recedes.

The value label of a vertical reference line MUST sit at the axis end, out of the title band. A horizontal line keeps its label at the right edge.

A category series name MUST prettify at derivation: underscores become spaces, deterministically. The tooltip reads the same name, and the raw value stays in the data rows.

#### Scenario: The volcano titles its axes

- **WHEN** the caller derives a `volcano` chart with no axes override and no declared label
- **THEN** the x axis reads `log2 fold change`, and the y axis reads `−log10(p)`

#### Scenario: A declared label beats the preset title

- **WHEN** the binding declares a label for the effect column of a `volcano`
- **THEN** the x axis reads the declared label

#### Scenario: The null category recedes

- **WHEN** a `volcano` groups by a column whose values hold `ns`
- **THEN** the `ns` series carries the muted chart color, and the other series keep the palette

#### Scenario: A vertical guide labels at the axis

- **WHEN** the caller derives a chart with a vertical reference line
- **THEN** the value label of the line sits at the axis end, and the title band stays clear

#### Scenario: The legend reads words

- **WHEN** a chart groups by a column whose value is `up_in_nonresponders`
- **THEN** the series name reads `up in nonresponders`, and the data rows keep the raw value
