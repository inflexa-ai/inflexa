## MODIFIED Requirements

### Requirement: Fixed-gutter message block

`MessageBlock` SHALL render a fixed-width gutter column (2 spaces) whose marker swaps by role, taken from the shared gutter marker set (`markers.ts`): `>` for the user (`theme().user`) and `<` for the assistant (`theme().assistant`), followed by the role label and the markdown body. The gutter width SHALL be constant regardless of marker, so future block types align identically. Streaming assistant text SHALL render from the live stream signal and flush into the message store on completion, exactly as before this change.

An assistant turn's header SHALL carry a meta line of the facts the application actually holds for that turn — its ordinal, its duration, and its recorded token figures in the shared notation (`usage-figure-rendering`). Each SHALL be rendered ONLY when held: a turn whose provider reported no usage SHALL show no figure, and no meta value SHALL be estimated, derived, or otherwise fabricated to fill the line. A user turn SHALL carry no token figure — the cost was not incurred by the party that sent the message.

The prohibition this requirement previously carried — that no meta footer be rendered at all, on the grounds that the data is not tracked — no longer describes the system: the turn's usage rollup is now tracked end to end and rendered live. The rule that survives it is the one that mattered, restated above: what is not held is not shown.

A user turn SHALL additionally differentiate itself with a left border rule in the user color (`border={["left"]}`, `theme().user`) on its parts container — the design system's quoted-content idiom. The rule MUST NOT break gutter alignment: the border glyph consumes one cell, so the user body's left padding SHALL shrink by one cell to keep body text in the same column as assistant bodies, and the header line (the `>` marker in the gutter) SHALL stay outside the bordered box. Assistant turns are unchanged.

#### Scenario: Role selects the marker

- **WHEN** a user turn and an assistant turn render
- **THEN** the user turn shows `>` in the user color and the assistant turn shows `<` in the assistant color, both in the same 2-space gutter column

#### Scenario: Streaming behavior preserved

- **WHEN** the assistant response streams in
- **THEN** deltas render live and flush into the store on completion, identical to the pre-change behavior

#### Scenario: An assistant turn shows the figures it has

- **GIVEN** a completed turn whose provider reported usage
- **THEN** the assistant header carries its token figures in the shared notation

#### Scenario: A turn that reported nothing shows no figure

- **GIVEN** a completed turn whose provider reported no usage
- **THEN** the assistant header carries its ordinal and duration and no token figure

#### Scenario: A user turn carries no token figure

- **WHEN** a user turn renders
- **THEN** its header carries no token figure

#### Scenario: User turns carry the rule, aligned

- **WHEN** a user turn renders above an assistant turn
- **THEN** the user body shows a left rule in the user color, and both bodies' text starts in the same column (the rule + reduced padding equals the assistant's gutter indent)
