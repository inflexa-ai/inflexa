# Delta: report-design-system

## MODIFIED Requirements

### Requirement: A considered component for each block kind
The renderer MUST give each block kind its identity component:

- A `text` block renders as prose with a capped measure.
- A `claim` block renders as prose with the styled evidence markers.
- A `metric` block renders as a stat card with a mono value and an accent. The value MUST stay inside the card: the card carries an overflow guard, thus a long value can never paint past the card edge.
- A consecutive run of `metric` siblings renders as one responsive grid.
- A `table` block renders as a data table inside a corner-accent card.
- A `chart` block renders as a window-chrome panel with a fixed-height chart body.
- A `figure` block renders as a corner-accent card with its caption.
- A `citation` block renders as a card in the reference form.
- A `section` block renders as a heading by depth.

#### Scenario: Consecutive metrics form one grid
- **WHEN** the caller renders a section with three metric blocks in a row
- **THEN** one grid holds the three stat cards

#### Scenario: A lone metric stays a card
- **WHEN** the caller renders a section with one metric block between two text blocks
- **THEN** the metric renders as one stat card, and no grid wraps the text

#### Scenario: A chart panel carries the chrome and a height
- **WHEN** the caller renders a chart block
- **THEN** the panel holds the chrome header with the dots and the `CORTEX` badge, and the chart container carries a fixed height

#### Scenario: A long metric value stays inside its card
- **WHEN** the caller renders a metric whose formatted value still runs wide on a narrow card
- **THEN** the value stays inside the card bounds, and no character paints past the card edge
