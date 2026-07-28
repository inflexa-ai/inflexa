## ADDED Requirements

### Requirement: The chat shell composes a run-activity panel between stream and input

The chat shell's main column SHALL compose, in order: the message stream's scroll region, the
run-activity panel, then the input. The panel SHALL be part of the composition kit alongside the
status bar, message block, chat bar, and sidebar.

The panel SHALL contribute rows only when it has a run to show and has not been dismissed;
otherwise the stream and input SHALL compose exactly as they do without it.

The scroll region SHALL remain the flexible child that absorbs vertical pressure, so adding the
panel reduces visible stream rows rather than squeezing the input or the panel itself.

#### Scenario: The panel takes its place in the column

- **WHEN** a run is active and the panel is not dismissed
- **THEN** the shell renders the stream, then the panel, then the input, in that order

#### Scenario: No active run leaves the layout unchanged

- **WHEN** no run is active
- **THEN** the shell's composition is identical to one with no panel at all

#### Scenario: The stream absorbs the space

- **WHEN** the panel appears during an active run
- **THEN** the scroll region shrinks to make room and the input keeps its full height

### Requirement: Fixed chrome below the scroll region is opaque and non-shrinking

A fixed row placed directly beneath the message stream's scroll region SHALL render as a
full-width box painted with the panel background, and SHALL declare that it does not shrink.
This governs the run-activity panel and any future chrome in that position.

Both properties are load-bearing rather than stylistic. A `flexGrow` scroll region renders one row
taller than the height it contributes to the column, so the row beneath it overlaps the scroll
region's last row; a bare text element paints only its own glyphs and lets scrolled content show
through the gaps between them. Separately, a non-numeric width defaults to shrinking, so an
unconstrained panel collapses below its own border on a short terminal.

Layout SHALL be verified across a range of terminal heights, since this class of defect is
size-dependent and passes at most single heights.

#### Scenario: Scrolled content does not bleed through

- **WHEN** the stream is scrolled so content sits at the boundary with the panel
- **THEN** the panel's row is fully painted across the width and no stream content is visible within it

#### Scenario: A short terminal does not collapse the panel

- **WHEN** the terminal height is reduced until the layout is under pressure
- **THEN** the panel retains its rows and the scroll region absorbs the reduction

#### Scenario: The defect is checked at more than one size

- **WHEN** the panel's layout is verified
- **THEN** it is exercised across a sweep of terminal heights rather than a single size
