# Delta: report-design-system

## MODIFIED Requirements

### Requirement: A considered component for each block kind
The renderer MUST give each block kind its identity component:

- A `text` block renders as prose that fills the content column.
- A `claim` block renders as prose with the styled evidence markers.
- A `metric` block renders as a stat card with a mono value and an accent. The value MUST stay inside the card: the card carries an overflow guard, thus a long value can never paint past the card edge.
- A consecutive run of `metric` siblings renders as one responsive grid.
- A `table` block renders as a data table inside a corner-accent card.
- A `chart` block renders as a corner-accent card with a mono title line and a fixed-height chart body. The card carries no window chrome, no dots, no badge, and no hover raise, because a report is a document and not an application window.
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
- **THEN** the card holds the title line and the fixed-height chart body, and no dot, no badge, and no hover raise is present

#### Scenario: A long metric value stays inside its card
- **WHEN** the caller renders a metric whose formatted value still runs wide on a narrow card
- **THEN** the value stays inside the card bounds, and no character paints past the card edge

### Requirement: The geometric identity rules
A data card MUST hold square corners with the corner accents. The theme MUST stay light: white and slate surfaces, with dark only in the footer.

#### Scenario: A figure card keeps the square corners
- **WHEN** the caller renders a figure block
- **THEN** its card carries the corner accents and no border radius

#### Scenario: A chart card keeps the square corners
- **WHEN** the caller renders a chart block
- **THEN** its card carries the corner accents and no border radius

### Requirement: The page architecture
The page MUST hold these regions in this order: the hero, one full-bleed band for each top-level section, the reference band, and the dark footer. The hero MUST show a constant eyebrow and the document title. The band backgrounds MUST alternate between white and slate, and each band MUST carry a texture. The left navigation MUST shift the page body on a large viewport.

One centered content column MUST hold every block kind, and the prose MUST fill that column completely. No inner measure caps the prose below the column width.

The navigation brand MUST link to the Inflexa site, and the footer MUST read `Powered by Inflexa`. No page surface names the internal engine.

#### Scenario: The bands alternate
- **WHEN** the caller renders a document with three top-level sections
- **THEN** the second band carries the slate background, and the first and the third carry the white background

#### Scenario: The hero shows the title
- **WHEN** the caller renders a document with the title "Study X"
- **THEN** the hero shows "Study X" as the display heading, under the eyebrow

#### Scenario: The footer closes the page
- **WHEN** the caller renders any valid document
- **THEN** the dark footer renders after the reference band

#### Scenario: The blocks share one centered column
- **WHEN** the caller renders a document with prose, a table, and a chart
- **THEN** the three blocks share one content column, and no prose rule caps a narrower measure

#### Scenario: The page carries the identity wording
- **WHEN** the caller renders any valid document
- **THEN** the navigation brand links to the Inflexa site, the footer reads `Powered by Inflexa`, and no surface names the engine
