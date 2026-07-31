## ADDED Requirements

### Requirement: A token figure has two written forms, and the surface selects between them

The system SHALL define exactly two renderings of a recorded token figure, both in one module, and every surface that prints a figure SHALL call one of them rather than composing its own:

- a **labelled** form naming each quantity in words — `820.3k in · 43.3k out`;
- a **compact** form prefixing each quantity with the design system's up and down arrows — `↑820.3k ↓43.3k`.

Two forms, not one. A figure that is the SUBJECT of the surface it sits on is read deliberately and can afford words; a figure DECORATING a row whose subject is something else is scanned in passing and must not crowd the thing it annotates. Collapsing both cases into the compact form makes every figure terse in service of the few that had to be, and collapsing them into the labelled form pushes the rail's rows into wrapping. Neither cost is worth paying on the surfaces that did not incur it.

Which form a surface uses is a property of THAT SURFACE and SHALL be stated where the surface is specified, not decided at the call site. Both forms SHALL be built from the same quantities by the same module, so a value can never differ between them — only its presentation.

**Where the figure is a property line or a header rather than a list row, the labelled form applies.** A detail dialog's `usage` line sits among `started` / `completed` / `duration` lines in one `label value` vocabulary and is read at a full panel width; a chat turn's header runs the width of the stream and carries three or four facts. Both are read, not scanned, so both spell the quantities out. The compact form is for what is genuinely a decoration on a row in a list: the rail's DATA PROFILE and RUNS lines, the run block's step rows, picker rows, and the usage dialog's grouping rows — surfaces where several figures are compared down a column, or where a 37-cell rail is the whole budget.

The arrows SHALL come from the shared glyph set, never inlined at a call site, and SHALL be read from the reader's seat — what was sent up, what came back down.

#### Scenario: The two forms carry the same quantities

- **GIVEN** one recorded set of quantities
- **WHEN** the labelled and compact forms are rendered
- **THEN** both name the same input and output values, differing only in how each is labelled

#### Scenario: A decorating figure fits the rail

- **WHEN** the compact form renders as a row decoration in the sidebar at its design width
- **THEN** it occupies one line and is not truncated

#### Scenario: A property line spells its quantities out

- **WHEN** a figure renders as a `label value` line among a record's other properties in a detail dialog
- **THEN** it uses the labelled form, matching the lines above it rather than the rail's decorations

#### Scenario: No surface composes its own figure

- **WHEN** any surface renders recorded quantities
- **THEN** it does so through one of the two shared forms, with no locally assembled variant

### Requirement: One component renders every figure, in the form its surface names

Every figure the interface paints SHALL come from ONE shared component that takes the quantities and the form to write them in. No surface SHALL lay out its own arms, indent its own breakdowns, or choose its own tones for them.

The written forms already come from one module, which is what stops two surfaces disagreeing about a VALUE. This requirement is the matching rule for PRESENTATION, which is where the more dangerous disagreement lives: a surface free to lay out its own arms is free to level the cache quantities up beside input, and that layout is a standing invitation to add a cached prefix to the total it is already inside. A shared writer with per-surface layout leaves exactly the mistake this notation exists to prevent available at every call site.

The form SHALL be a parameter, so that moving a surface between forms is a one-word change at that surface and cannot drift into a hand-composed variant.

The component SHALL resolve an explicit foreground for every span it paints, including absences. An unresolved foreground renders as opaque white, which scores 12–18:1 against the dark themes and 1.00–1.13:1 against the light ones — legible where it is wrong and invisible where it matters, so a review on the dark default cannot see it.

#### Scenario: A surface changes form without changing layout code

- **WHEN** a surface moves from the compact form to the labelled one
- **THEN** only the form it names changes, and its layout, tones, and nesting are unchanged

#### Scenario: Every figure is legible on a light theme

- **GIVEN** a theme whose background is pure white
- **WHEN** a figure renders, including one whose quantities were never reported
- **THEN** every painted span resolves a foreground from the palette rather than defaulting to white

### Requirement: The two arms of a labelled figure sit at opposite edges of one row

Where the labelled form renders as a block, input SHALL sit at the leading edge and output at the trailing edge of the SAME row, and each arm's nested quantities SHALL be indented beneath their own arm.

The arms are peers the reader is comparing, so each belongs at an edge it can be found at without scanning. Stacking them instead spends a second row on a relationship that is not there — costly on the rail, whose rows are its scarcest resource and which shares them with five other sections — and putting each arm at the head of one half leaves the trailing figure floating mid-panel, adjacent to nothing.

The layout SHALL NOT vary with the data: a figure with nothing nested under either arm occupies the same one row as one with breakdowns under both. A block that changed shape as its quantities changed would make the surface jump between renders and would give the reader a second thing to interpret.

An arm whose quantity was never reported SHALL keep its position and render the absent word there. Dropping the column entirely would leave a half figure looking like a whole one to a reader scanning the trailing edge.

#### Scenario: Output is found at the trailing edge

- **WHEN** a labelled figure renders in a panel or in the rail
- **THEN** its output arm ends at the trailing edge rather than mid-width

#### Scenario: The nested quantities stay under their own arm

- **GIVEN** a figure carrying cache quantities under input and a reasoning quantity under output
- **WHEN** it renders
- **THEN** each nested quantity is indented under the arm it is part of, on a row below the arms

#### Scenario: The shape does not depend on the data

- **GIVEN** one figure with nested quantities and one without
- **WHEN** both render
- **THEN** both place their two arms on a single row at the same two edges

### Requirement: An unreported quantity is omitted, never rendered as zero

A quantity the ledger holds as absent SHALL be omitted from the figure entirely. A figure whose input alone was reported SHALL render only its input arm, and one where nothing was reported SHALL render as a muted absence distinguished by tone from a zero.

A zero SHALL only ever render when a provider actually reported zero. This is the same absent-means-not-reported discipline the ledger stores under, carried through to the last layer that can lose it — a rendering that substitutes `0` for absence destroys the distinction every layer beneath it preserved.

A positional notation that cannot express a missing arm — `767.6k/33.1k` and its kind — SHALL NOT be used, because a half figure is a normal state here and a positional form renders it as a mistake.

Both forms SHALL behave identically here. Absence is a property of the data, so a quantity missing from one rendering and printed as zero in the other would make the two forms disagree about what was measured.

#### Scenario: A half-reported figure renders one arm

- **GIVEN** a call whose provider reported input tokens and no output tokens
- **WHEN** its figure renders
- **THEN** only the input arm appears, with no zero output arm

#### Scenario: Nothing reported is not shown as zero

- **GIVEN** an entity whose calls reported no quantity at all
- **WHEN** its figure renders
- **THEN** a muted absence renders rather than a zero figure

#### Scenario: A reported zero is shown

- **GIVEN** a call whose provider reported zero output tokens
- **WHEN** its figure renders
- **THEN** the output arm shows zero rather than being omitted

### Requirement: The cache quantities render as parts of input, never beside it

Where a surface has the room to show the cache-write and cache-read quantities, they SHALL render subordinate to the input quantity — indented beneath it or otherwise visibly nested — and SHALL NOT be placed on the same visual level as input and output.

They are breakdowns OF the input total, not amounts alongside it, and a layout that levels them invites the reader to add them to a total they are already inside. For the same reason no surface SHALL render a single combined token figure at any grain.

#### Scenario: Cache figures are nested under input

- **GIVEN** an entity whose rows carry cache-write and cache-read quantities
- **WHEN** its detailed figure renders
- **THEN** the cache quantities appear subordinate to the input quantity, not as siblings of input and output

#### Scenario: No surface prints a combined total

- **GIVEN** an entity with input, output, cache, and reasoning quantities
- **WHEN** any surface renders its usage
- **THEN** no single summed token number appears
