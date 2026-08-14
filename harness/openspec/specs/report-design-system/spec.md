# report-design-system Specification

## Purpose
The visual identity that a block document renders through. It covers the tokens, the typography, the per-kind components, the page architecture, the print form, and the evolution rule.

## Requirements
### Requirement: The page carries the identity tokens
The inline style sheet MUST define the identity tokens as CSS custom properties. The set covers the primary scale, the neutral roles, the data-visualization colors, the semantic tag pairs, and the stat accents. The body font MUST be Space Grotesk. Each label, each badge, each table header, and each data value MUST render in IBM Plex Mono. A heading MUST NOT render in the mono font.

#### Scenario: The token sheet is present
- **WHEN** the caller renders any valid document
- **THEN** the inline style sheet defines the primary scale and the data-visualization colors as custom properties

#### Scenario: A table header renders in the mono font
- **WHEN** the caller renders a table block
- **THEN** the table header carries the mono font form, in uppercase

### Requirement: The page architecture
The page MUST hold these regions in this order: the hero, one full-bleed band for each top-level section, the reference band, and the dark footer. The hero MUST show a constant eyebrow and the document title. The band backgrounds MUST alternate between white and slate, and each band MUST carry a texture. The left navigation MUST shift the page body on a large viewport.

#### Scenario: The bands alternate
- **WHEN** the caller renders a document with three top-level sections
- **THEN** the second band carries the slate background, and the first and the third carry the white background

#### Scenario: The hero shows the title
- **WHEN** the caller renders a document with the title "Study X"
- **THEN** the hero shows "Study X" as the display heading, under the eyebrow

#### Scenario: The footer closes the page
- **WHEN** the caller renders any valid document
- **THEN** the dark footer renders after the reference band

### Requirement: A considered component for each block kind
The renderer MUST give each block kind its identity component:

- A `text` block renders as prose with a capped measure.
- A `claim` block renders as prose with the styled evidence markers.
- A `metric` block renders as a stat card with a mono value and an accent.
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

### Requirement: The geometric identity rules
A data card MUST hold square corners with the corner accents. The window-chrome panel is the one exception, and it MUST hold rounded corners. The theme MUST stay light: white and slate surfaces, with dark only in the footer.

#### Scenario: A figure card keeps the square corners
- **WHEN** the caller renders a figure block
- **THEN** its card carries the corner accents and no border radius

### Requirement: The print form and the reduced motion
The style sheet MUST hold a print block that hides each texture, shows each fade-in element, and turns the footer light. The style sheet MUST collapse each animation duration under `prefers-reduced-motion: reduce`.

#### Scenario: The print block is present
- **WHEN** the caller renders any valid document
- **THEN** the style sheet holds a `@media print` block that hides the textures and shows each fade-in element

#### Scenario: The reduced-motion block is present
- **WHEN** the caller renders any valid document
- **THEN** the style sheet holds a `prefers-reduced-motion` block that collapses the durations

### Requirement: The design evolves through the design source
The design MUST live in the renderer source: the design sheet module and the views. The repository MUST hold one fixture document that covers every block kind. A package script MUST render the fixture to a file and print the path, thus a person examines a design edit directly.

#### Scenario: The fixture covers every kind
- **WHEN** the fixture document renders
- **THEN** the page holds each of the eight block kinds, and the validity gates pass

#### Scenario: The script renders the fixture
- **WHEN** a person runs the fixture script
- **THEN** the script writes the fixture page with its assets, and it prints the path

### Requirement: A block kind names content, never presentation
The block grammar MUST name content and its grounding, and it MUST NOT name presentation. A presentation improvement MUST land in the renderer, not in the grammar. A new block kind is correct only when the agent must supply content that no current kind carries, with its own binding shape. The grammar MUST NOT gain a style field.

#### Scenario: A presentation ask changes no grammar
- **WHEN** a report needs a donut form in place of a pie form
- **THEN** the change lands in the renderer, and the block grammar does not change
