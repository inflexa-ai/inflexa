## MODIFIED Requirements

### Requirement: The chat turn stores each compaction round

The round sink of the turn MUST store the two rounds of a compaction, each in one transaction: the exchange, and then the marker with its records. The exchange MUST carry no display projection. The marker round MUST carry the divider of the marker on the row of the marker (see the harness-thread-history capability).

The turn record, the paged read of whole turns, and the tail retract read the user message as the first row of a turn. Thus the sink MUST write the rounds of a turn-start compaction with `appendTurn`, before the opening, with no turn record. The turn opens at the user message, after those rounds.

The display recorder MUST NOT take the text of an exchange message as the text of a round. Thus the summary never shows as a reply of the assistant, live or after a reload.

After a marker round, the recorder MUST give the later rounds of the turn a new assistant id. The divider separates the rounds before it from the rounds after it. Thus the replay gives two assistant messages, and the two must not share an id. The stream announces the new id before the next event (see the chat-frame-translation capability).

The rows of a mid-turn compaction belong to the turn that made them. A tail retract removes them with that turn, and the view then goes back to the previous marker. The rows of a turn-start compaction come before the user message of the turn. Thus a tail retract of that turn keeps them, and a turn-start summary stays in the view. The host makes no new call for a compaction.

#### Scenario: A reload shows the divider between two rounds

- **GIVEN** a turn that compacts between its first and its second round
- **WHEN** `loadAll` reads the thread and the transcript replay runs
- **THEN** the replay gives the user message, an assistant message, the divider, and an assistant message
- **AND** the two assistant messages carry two different ids

#### Scenario: A reload shows a turn-start divider before the user message

- **GIVEN** a turn that starts with a turn-start compaction with a summary
- **WHEN** `loadAll` reads the thread and the transcript replay runs
- **THEN** the replay gives the divider, then the user message of the turn, and then its assistant message

#### Scenario: The summary is not a reply

- **GIVEN** a turn that compacts with a summary
- **WHEN** the transcript replay runs
- **THEN** no assistant message of the replay holds the text of the summary

#### Scenario: The next turn starts from the summary

- **GIVEN** a `conversation` thread whose last turn compacted
- **WHEN** the next turn is prepared
- **THEN** its history starts with the summary marker and its records, and then the later rounds

#### Scenario: A retract removes the mid-turn compaction of the last turn

- **GIVEN** a thread whose last turn did a mid-turn compaction after an earlier summary marker
- **WHEN** `retractLastTurn` removes the last turn
- **THEN** no row of the exchange or of the new marker remains, and the next turn starts from the earlier summary marker

#### Scenario: A retract keeps the turn-start compaction of the last turn

- **GIVEN** a thread whose last turn started with a turn-start compaction with a summary
- **WHEN** `retractLastTurn` removes the last turn
- **THEN** the rows of the exchange and of the marker remain, and the next turn starts from that summary marker
