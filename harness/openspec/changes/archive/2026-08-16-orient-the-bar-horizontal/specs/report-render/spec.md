# Delta: report-render

## ADDED Requirements

### Requirement: The horizontal bar renders with the category on y

A horizontal bar MUST render the category axis on y and the value axis on x. The category axis MUST keep every label, because the long names are the reason the orientation exists. An annotation names a rendered axis, thus a zero line on the horizontal value axis is an `x` reference line. The axis titles, the declared labels, and the number rules bind to the axes wherever they render. A composition that mixes a horizontal bar with another series on one grid MUST refuse as a render problem.

#### Scenario: The NES chart renders horizontal with a zero line

- **WHEN** the caller derives a horizontal bar over a set-name column and an NES column, with an `x` reference line at zero
- **THEN** the category axis sits on y with every label, and the zero line stands on the value axis

#### Scenario: A vertical bar stays as it is

- **WHEN** the caller derives a bar with no orientation
- **THEN** the option is byte-identical to the option before the orientation existed

#### Scenario: A mixed grid refuses

- **WHEN** a composition holds a horizontal bar series and a scatter series
- **THEN** the derivation refuses with a problem that names the mix

#### Scenario: An orientation on a non-bar refuses

- **WHEN** the author states an orientation beside the `line` chart type
- **THEN** the render refuses with a problem that names the fault
