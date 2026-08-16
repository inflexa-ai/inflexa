# Delta: report-block-model

## MODIFIED Requirements

### Requirement: The chart grammar

The bar MUST admit an optional orientation: `vertical`, the default, and `horizontal`. The quick path carries the orientation beside the chart type, and the composition carries it on the bar series form. The channels keep their data meaning in both orientations: `x` names the category column, and `y` names the value column. An orientation beside a quick-path type that is not a bar is an authoring fault.

#### Scenario: A horizontal bar validates

- **WHEN** the author binds a quick-path `bar` with the `horizontal` orientation
- **THEN** the block validates, and the orientation rides the stored document

#### Scenario: An orientation on a non-bar refuses

- **WHEN** the author states an orientation beside the `line` chart type
- **THEN** the render refuses with a problem that names the fault

#### Scenario: An absent orientation stays vertical

- **WHEN** a stored bar block carries no orientation
- **THEN** the block validates, and the chart renders exactly as before
