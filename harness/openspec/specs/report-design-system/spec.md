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

### Requirement: A considered component for each block kind
The renderer MUST give each block kind its identity component:

- A `text` block renders as prose that fills the content column.
- A `claim` block renders as prose with the styled evidence markers.
- A `metric` block renders as a stat card with a mono value and an accent. The value MUST stay inside the card: the card carries an overflow guard, thus a long value can never paint past the card edge.
- A consecutive run of `metric` siblings renders as one responsive grid.
- A `table` block renders as a data table inside a corner-accent card. The card carries the sort headers, the filter input, and the row-cap toggle.
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
- **THEN** the title line sits over the card, and the card holds the fixed-height chart body with no dot, no badge, and no raise

#### Scenario: A long metric value stays inside its card
- **WHEN** the caller renders a metric whose formatted value still runs wide on a narrow card
- **THEN** the value stays inside the card bounds, and no character paints past the card edge

#### Scenario: The table carries the enhancer controls
- **WHEN** the caller renders a table block
- **THEN** the card holds the sort headers and the filter input, in the identity styles of the design source

### Requirement: The geometric identity rules
A data card MUST hold square corners with the corner accents. The theme MUST stay light: white and slate surfaces, with dark only in the footer.

#### Scenario: A figure card keeps the square corners
- **WHEN** the caller renders a figure block
- **THEN** its card carries the corner accents and no border radius

#### Scenario: A chart card keeps the square corners
- **WHEN** the caller renders a chart block
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

### Requirement: The lineage popover is a component of the design system
The popover MUST take each color, each space value, and each type value from the design tokens. The control is one inline stroke SVG on the 16px grid, drawn in the view, muted at rest and primary on hover. The rail marks the pinned artifact with the primary tint, a raw input with the terminal tint, and a producer row with the mono type. The design fixture MUST cover the popover control on a grounded block. Each new CSS class of the popover MUST have an emitting view.

#### Scenario: The fixture covers the popover
- **WHEN** the design fixture renders
- **THEN** one grounded block shows the branch-glyph control, with a document asset that gives it a chain

#### Scenario: No orphan class
- **WHEN** the design sheet gains a popover class
- **THEN** a view emits that class in the rendered page
