## ADDED Requirements

### Requirement: The display of a round comes from the stream of its turn

The display recorder of a turn workflow MUST build the display projection of a round from the frames of that round in the stream of the turn. A step that a recovery replays emits no event, but its frames from the first attempt are in the stream. Thus the stored display of a replayed round MUST be the same as the display of a round with no crash.

#### Scenario: A replayed tool call keeps its card

- **GIVEN** a round whose `show_plan` call completed, and then the host stopped before the round write
- **WHEN** the turn recovers and stores the round
- **THEN** the stored display of the round holds the plan card and the tool part of the call, one time each
