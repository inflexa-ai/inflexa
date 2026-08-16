## MODIFIED Requirements

### Requirement: Fixed-gutter message block

`MessageBlock` MUST render a fixed-width gutter column (2 spaces) whose marker swaps by role, taken from the shared gutter marker set (`markers.ts`): `>` for the user (`theme().user`) and `<` for the assistant (`theme().assistant`), followed by the role label and the markdown body. The gutter width MUST be constant regardless of marker, thus future block types align identically. Streaming assistant text MUST render from the live stream signal and flush into the message store on completion, exactly as before this change.

An assistant turn's header MUST carry a meta line of the facts the application holds for that turn: its ordinal, its duration, and its recorded token figures in the labeled form of the shared notation (`usage-figure-rendering`). Each renders ONLY when held. A turn whose provider reported no usage shows no figure, and no meta value is estimated, derived, or fabricated to fill the line. A user turn MUST carry no token figure, because the cost was not incurred by the party that sent the message.

The labeled form here, unlike the rail's rows. This header runs the full width of the stream and carries three or four facts at most, thus it has the cells to spend. It is also the one place a figure appears on EVERY turn, which makes it where a reader learns the notation. Words teach it, and arrows assume it was taught.

The figures MUST survive a transcript reload. The turn's rollup and its duration persist onto the turn's own assistant message, through the harness turn append. The load reads them back. Thus a reopened conversation carries the same figures and the same duration that the live headers showed. A row that predates the durable field, and an aborted turn that kept no reply, read back without a duration, and the header shows none. An interrupted turn that kept a partial reply keeps its duration, thus the reloaded header equals the live one. Absence keeps one meaning on every meta value: it was never recorded. What is not held is not shown.

A user turn MUST also carry a left border rule in the user color (`border={["left"]}`, `theme().user`) on its parts container. This is the quoted-content idiom of the design system. The rule MUST NOT break gutter alignment. The border glyph consumes one cell. Thus the user body's left padding shrinks by one cell, and body text stays in the column of the assistant bodies. The header line (the `>` marker in the gutter) stays outside the bordered box. Assistant turns are unchanged.

#### Scenario: Role selects the marker

- **WHEN** a user turn and an assistant turn render
- **THEN** the user turn shows `>` in the user color, and the assistant turn shows `<` in the assistant color
- **AND** both markers sit in the same 2-space gutter column

#### Scenario: Streaming behavior preserved

- **WHEN** the assistant response streams in
- **THEN** deltas render live and flush into the store on completion, identical to the pre-change behavior

#### Scenario: An assistant turn shows the figures it has

- **GIVEN** a completed turn whose provider reported usage
- **THEN** the assistant header carries its token figures in the shared notation

#### Scenario: A turn that reported nothing shows no figure

- **GIVEN** a completed turn whose provider reported no usage
- **THEN** the assistant header carries its ordinal and duration and no token figure

#### Scenario: A reloaded turn still shows its figures and its duration

- **GIVEN** a completed turn whose provider reported usage, in a conversation that is then reopened
- **WHEN** the transcript loads
- **THEN** the turn's header carries the same figures and the same duration it showed live

#### Scenario: An old row shows no duration

- **GIVEN** a stored turn that predates the durable duration
- **WHEN** the transcript loads
- **THEN** the turn's header carries its other facts and no duration, and nothing reconstructs one

#### Scenario: A user turn carries no token figure

- **WHEN** a user turn renders
- **THEN** its header carries no token figure

#### Scenario: User turns carry the rule, aligned

- **WHEN** a user turn renders above an assistant turn
- **THEN** the user body shows a left rule in the user color, and both bodies' text starts in the same column (the rule + reduced padding equals the assistant's gutter indent)
