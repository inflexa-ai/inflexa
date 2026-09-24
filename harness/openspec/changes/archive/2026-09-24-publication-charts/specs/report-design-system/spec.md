# Spec Delta

## MODIFIED Requirements

### Requirement: The page carries the identity tokens
The inline style sheet MUST define the identity tokens as CSS custom properties. The set covers the primary scale, the neutral roles, the data-visualization colors, the semantic tag pairs, and the stat accents. The body font MUST be Space Grotesk. Each label, each badge, each table header, and each data value MUST render in IBM Plex Mono. A heading MUST NOT render in the mono font. The text inside a chart is the one exception: it renders in the journal sans stack of the chart theme, because a figure keeps its own typography on the page and in the paper.

#### Scenario: The token sheet is present
- **WHEN** the caller renders any valid document
- **THEN** the inline style sheet defines the primary scale and the data-visualization colors as custom properties

#### Scenario: A table header renders in the mono font
- **WHEN** the caller renders a table block
- **THEN** the table header carries the mono font form, in uppercase

#### Scenario: The chart text keeps its own font
- **WHEN** the caller renders a chart block
- **THEN** the chart theme names the journal sans stack, and the page fonts do not reach the chart text

### Requirement: A considered component for each block kind
The renderer MUST give each block kind its identity component:

- A `text` block renders as prose that fills the content column.
- A `claim` block renders as prose with the styled evidence markers.
- A `metric` block renders as a stat card with a mono value and an accent. The value MUST stay inside the card: the card carries an overflow guard, thus a long value can never paint past the card edge.
- A consecutive run of `metric` siblings renders as one responsive grid.
- A `table` block renders as a data table inside a corner-accent card. The card carries the sort headers, the filter input, and the row-cap toggle.
- A `chart` block renders as a corner-accent card with a mono title line, a fixed-height chart body, and an export row. The body grows one row of height for each row of facet panels. The card carries no window chrome, no dots, no badge, and no hover raise, because a report is a document and not an application window.
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

#### Scenario: A chart card carries the export row
- **WHEN** the caller renders a chart block
- **THEN** the card holds the export row under the chart body, with the SVG links and the PNG controls

#### Scenario: A faceted chart grows its body
- **WHEN** the caller renders a chart block whose facet gives two rows of panels
- **THEN** the chart body carries the two-row height class

#### Scenario: A long metric value stays inside its card
- **WHEN** the caller renders a metric whose formatted value still runs wide on a narrow card
- **THEN** the value stays inside the card bounds, and no character paints past the card edge

#### Scenario: The table carries the enhancer controls
- **WHEN** the caller renders a table block
- **THEN** the card holds the sort headers and the filter input, in the identity styles of the design source

### Requirement: The design evolves through the design source
The design MUST live in the renderer source: the design sheet module and the views. The repository MUST hold one fixture document that covers every block kind and every chart form that the grammar names, with the publication look. A package script MUST render the fixture to a file and print the path, thus a person examines a design edit directly.

#### Scenario: The fixture covers every kind
- **WHEN** the fixture document renders
- **THEN** the page holds each of the eight block kinds, and the validity gates pass

#### Scenario: The fixture covers every chart form
- **WHEN** the fixture document renders
- **THEN** the page holds one chart of each base type, one of each preset, one interval, one facet, one focus, and one continuous color

#### Scenario: The script renders the fixture
- **WHEN** a person runs the fixture script
- **THEN** the script writes the fixture page with its assets, and it prints the path

## ADDED Requirements

### Requirement: The chart theme is a publication figure
The chart theme MUST render each chart as a journal figure on the page and in the export. The left axis line and the bottom axis line are strong and dark. There is no top axis line, no right axis line, and no grid line. The legend carries no frame, and the tooltip stays for the page. The chart text renders in the journal sans stack (Helvetica, Arial, then a generic sans-serif), in a near-black color. The palette is colorblind-safe, and no two hues differ by a red-green difference alone. The first hue is the focus color. The muted color serves the null category and each category outside a focus.

Each bar item MUST carry a value label when the chart holds twelve items or fewer, as the `report-render` rule states. A bar that carries an interval carries no value label, because the whisker stands where the label would stand. The label text is the shown form of the number helper, as a static per-item string. Thus the label reads as the card beside it reads, and the plotted value stays the cell.

The theme MUST take no code, no text, no palette value, and no image from figures4papers. It follows the principles alone.

#### Scenario: The axes read as a figure
- **WHEN** the caller renders any chart block
- **THEN** the theme shows the left and the bottom axis lines, hides the split lines, and frames no legend

#### Scenario: The palette is colorblind-safe
- **WHEN** a reviewer reads the theme palette
- **THEN** each hue comes from a colorblind-safe set, and no two hues differ by a red-green difference alone

#### Scenario: A small bar chart labels its values
- **WHEN** the caller derives a bar over six categories
- **THEN** each item carries a static label with the shown form of its value

#### Scenario: A busy bar chart carries no labels
- **WHEN** the caller derives a bar over thirty categories
- **THEN** no item carries a value label
