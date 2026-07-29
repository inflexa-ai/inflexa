## MODIFIED Requirements

### Requirement: The run card settles into a terminal record

The run-card block SHALL render the launch record — the run, its title, and its identity — and,
once its run reaches a terminal status, a compact outcome line carrying the terminal status, the
completion count, and the duration, with the failure reason when it did not succeed.

The card SHALL NOT carry a live progress meter at any point in its life. Live run progress belongs
to the sidebar RUNS section and the run-activity panel; a meter here puts the same `done/total`
figure on screen three times for one run, and the panel's own counts are deliberately rendered as
bare text precisely so that two surfaces do not read as two widgets showing one run — an argument
that fails the moment a third meter exists. The card's role is the conversation's memory of a
launch, which is a record, not an instrument.

The card SHALL NOT be hidden or removed on completion. Run cards are reconstructed when a
transcript is reloaded, so a card that disappeared would erase the launch from the conversation's
history; and signalling completion by making a widget vanish is the defect this work exists to
remove.

A card whose run cannot be resolved SHALL render its identity and say so, never a fabricated
status.

#### Scenario: A launched run's card is a record, not an instrument

- **WHEN** a card's run is still active
- **THEN** the card shows the launch record with no progress meter, and live progress is read from the panel or the rail

#### Scenario: A completed run's card becomes an outcome line

- **WHEN** the run behind a rendered card completes
- **THEN** a compact line states the run, its terminal status, its counts, and its duration

#### Scenario: A failed run's card carries the reason

- **WHEN** the run behind a rendered card fails
- **THEN** the settled card is rendered in the error tone and carries the failure reason

#### Scenario: The card survives reload as a truthful record

- **WHEN** a transcript containing a finished run's card is reloaded
- **THEN** the card renders its settled outcome, not a placeholder and not a live meter

#### Scenario: One live progress figure per run on screen

- **WHEN** a run is active and its card, the rail, and the panel are all visible
- **THEN** the progress meter appears once, in the rail, and the card contributes no meter

#### Scenario: An unresolvable run is not faked

- **WHEN** a card's run cannot be found in the ledger
- **THEN** the card shows its recorded identity and an unavailable state rather than inventing a status
