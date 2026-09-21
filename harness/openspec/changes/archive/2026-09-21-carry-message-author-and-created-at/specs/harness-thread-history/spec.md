## ADDED Requirements

### Requirement: A turn stores the author of its user message

`appendTurn` MUST accept an optional author of the turn, a string that names the identity that sent the user message. The write MUST store it in the same transaction as the messages. The author lands on the first row of the append when that row is a genuine user start, and on no other row. That row is the row that carries the display projection, thus the write and the transcript read use one row. A synthetic message and an assistant row MUST carry no author. A caller that supplies none MUST leave each row without one.

The write MUST strip NUL from the author before the insert, the same as it strips NUL from the envelope. Thus a NUL in the value cannot fail the append.

The author MUST be nullable in storage, with no default and no backfill. A row written before the author existed MUST read back without one, because the value was never recorded. The author rides the message row, thus a retracted tail turn takes its author with it.

The model read (`loadRecent`) MUST NOT carry the author, because the provider does not see it.

#### Scenario: The author rides the user row

- **GIVEN** a turn appended with an author
- **WHEN** the thread is read back
- **THEN** the author is on the row of the user message, and on no assistant row and no tool row of that turn

#### Scenario: A turn appended without an author stores none

- **GIVEN** a turn appended without an author
- **WHEN** the thread is read back
- **THEN** no row of the turn carries an author

#### Scenario: A mid-turn synthetic message carries no author

- **GIVEN** a turn appended with an author, whose rows hold a marked synthetic nudge between two assistant rows
- **WHEN** the thread is read back
- **THEN** the user row carries the author, and the nudge row and each assistant row carry none

#### Scenario: A record append carries no author

- **GIVEN** an out-of-band record append that supplies an author
- **WHEN** the thread is read back
- **THEN** the record row carries no author, because the record is not the message of a person

#### Scenario: An old row reads back without an author

- **GIVEN** a database whose `messages` table predates the author column
- **WHEN** the state initialization runs, and the thread is read back
- **THEN** the column exists, nullable with no default, and each existing row carries no author

#### Scenario: A NUL in the author does not fail the append

- **GIVEN** a turn appended with an author that holds a NUL character
- **WHEN** the thread is read back
- **THEN** the append succeeded, and the stored author is the value without the NUL

#### Scenario: The model read is unchanged by an author

- **GIVEN** a turn appended with an author
- **WHEN** `loadRecent` reads the thread
- **THEN** the returned model messages equal the appended model messages, and no message holds an author

#### Scenario: A retracted turn takes its author with it

- **GIVEN** a tail turn whose user row carries an author
- **WHEN** the turn is retracted
- **THEN** neither the row nor its author remains

### Requirement: The transcript read carries the author and the creation time

The display read (`loadAll`) MUST return the creation time of each row, and the author of each row that holds one. The creation time is the start time of the transaction that appended the row, thus each row of one append holds the same time. The store gives no order between the times of two appends. The `seq` column orders the rows. The two members MUST be optional on the stored message type, because a fake or a fixture builds one with no row behind it.

The transcript replay MUST set the creation time on each `CortexMessage` of an append, as an ISO 8601 string, from the row that opens that append. It MUST set the author on each `CortexMessage` of the append whose role is `user`, from the same row. The two fields MUST be optional on `CortexMessage`. An absent value MUST have no key on the message, thus an absent value never reads as a real one. An assistant message MUST carry no author.

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
