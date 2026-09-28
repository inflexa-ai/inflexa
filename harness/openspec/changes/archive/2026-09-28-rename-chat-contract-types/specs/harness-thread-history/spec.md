## MODIFIED Requirements

### Requirement: The transcript read carries the author and the creation time

The display read (`loadAll`) MUST return the creation time of each row, and the author of each row that holds one. The creation time is the start time of the transaction that appended the row, thus each row of one append holds the same time. The store gives no order between the times of two appends. The `seq` column orders the rows. The two members MUST be optional on the stored message type, because a fake or a fixture builds one with no row behind it.

The transcript replay MUST set the creation time on each `ChatMessage` of an append, as an ISO 8601 string, from the row that opens that append. It MUST set the author on each `ChatMessage` of the append whose role is `user`, from the same row. The two fields MUST be optional on `ChatMessage`. An absent value MUST have no key on the message, thus an absent value never reads as a real one. An assistant message MUST carry no author.

The author and the creation time ride the message row only. The write MUST NOT copy either one into the display projection, under the same one-copy rule that keeps the rollup out of the projection.

#### Scenario: A reloaded turn carries its author and its time

- **GIVEN** a turn stored with an author
- **WHEN** the transcript replay runs
- **THEN** the user message carries the author and the creation time, and the assistant message carries the creation time and no author

#### Scenario: A turn stored without an author replays without one

- **GIVEN** a turn stored without an author
- **WHEN** the transcript replay runs
- **THEN** no message of the turn has an author key, and each message carries the creation time

#### Scenario: The creation time is the time of the append

- **GIVEN** a turn of more than one row, appended in one transaction
- **WHEN** the thread is read back
- **THEN** each row of the turn carries the same time, and each replayed message of the turn carries the ISO 8601 form of that time

#### Scenario: The display projection holds neither value

- **GIVEN** a turn appended with an author
- **WHEN** the stored display envelope of the turn is inspected
- **THEN** the envelope holds no author and no creation time
