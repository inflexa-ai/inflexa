## ADDED Requirements

### Requirement: A token figure has two written forms, and the surface selects between them

The system SHALL define exactly two renderings of a recorded token figure, both in one module, and every surface that prints a figure SHALL call one of them rather than composing its own:

- a **labelled** form naming each quantity in words — `820.3k in · 43.3k out`;
- a **compact** form prefixing each quantity with the design system's up and down arrows — `↑820.3k ↓43.3k`.

Two forms, not one. A figure that is the SUBJECT of the surface it sits on is read deliberately and can afford words; a figure DECORATING a row whose subject is something else is scanned in passing and must not crowd the thing it annotates. Collapsing both cases into the compact form makes every figure terse in service of the few that had to be, and collapsing them into the labelled form pushes the rail's rows into wrapping. Neither cost is worth paying on the surfaces that did not incur it.

Which form a surface uses is a property of THAT SURFACE and SHALL be stated where the surface is specified, not decided at the call site. Both forms SHALL be built from the same quantities by the same module, so a value can never differ between them — only its presentation.

The arrows SHALL come from the shared glyph set, never inlined at a call site, and SHALL be read from the reader's seat — what was sent up, what came back down.

#### Scenario: The two forms carry the same quantities

- **GIVEN** one recorded set of quantities
- **WHEN** the labelled and compact forms are rendered
- **THEN** both name the same input and output values, differing only in how each is labelled

#### Scenario: A decorating figure fits the rail

- **WHEN** the compact form renders as a row decoration in the sidebar at its design width
- **THEN** it occupies one line and is not truncated

#### Scenario: No surface composes its own figure

- **WHEN** any surface renders recorded quantities
- **THEN** it does so through one of the two shared forms, with no locally assembled variant

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
