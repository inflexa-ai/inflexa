# Spec Delta

## MODIFIED Requirements

### Requirement: A display read backs the messages endpoint

`ThreadHistory` MUST give two thread-scoped display reads of the `messages` table, which a host uses to serve the messages of a thread. Each display read MUST group the rows into whole turns, oldest-first. Each row MUST carry the fields that the other requirements of this capability state:

- its AI SDK model-message envelope
- its stored display envelope
- its stored rollup and its duration
- its turn record
- its author and its creation time.

The grouping by whole turns keeps a multi-row turn and the display projection on its first row together. A turn starts at a genuine user start. The rows before the first genuine user start of a thread make one group, and a display read counts that group as a turn.

- The whole read (`loadAll(threadId)`) MUST return every row of the thread.
- The page read MUST return the newest whole turns of the thread, up to a limit of turns that the caller gives. A caller that gives a cursor MUST get the newest whole turns before the turn that the cursor names. The read MUST also return the cursor of the next older page. The cursor MUST be `null` when the page holds the oldest row of the thread.

The page read MUST select and parse only the rows of the turns of its page. Thus its work does not grow with the count of the turns before its page. The page read MUST NOT truncate a turn, also for a cursor that no page gave. For a cursor that is not a turn start, the newest turn of the page MUST be the whole turn of the cursor row. Each page edge inside the thread is a turn start. A page holds a maximum of the limit of groups, the group before the first turn start included.

The page read MUST treat a limit below 1, or a limit that is not finite, as a limit of 1. The read MUST use the integer part of a larger limit.

The two reads MUST be distinct from `loadRecent` (which gives the view of the loop from the stored compaction markers), and they MUST NOT apply that view.

#### Scenario: The display read returns each turn of the thread

- **GIVEN** a thread with many turns
- **WHEN** `loadAll` is called
- **THEN** it returns every turn oldest-first, each with its model rows, display projection, and rollup

#### Scenario: The display read is not windowed

- **GIVEN** a thread whose latest compaction marker leaves earlier turns out of the view of the loop
- **WHEN** `loadAll` is called
- **THEN** it returns every turn, also the turns that the view leaves out

#### Scenario: The page read gives the newest turns

- **GIVEN** a thread of 5 turns
- **WHEN** the page read runs with a limit of 2 and no cursor
- **THEN** it returns the fourth and the fifth turn, oldest-first, each turn whole
- **AND** it returns a cursor that is not `null`

#### Scenario: The cursor gives the turns before the page

- **GIVEN** a thread of 5 turns, and the cursor of the page of the fourth and the fifth turn
- **WHEN** the page read runs with a limit of 2 and that cursor
- **THEN** it returns the second and the third turn, each turn whole, and a cursor that is not `null`

#### Scenario: The last page gives a null cursor

- **GIVEN** a thread of 5 turns, and the cursor of the page of the second and the third turn
- **WHEN** the page read runs with a limit of 2 and that cursor
- **THEN** it returns the first turn and the cursor `null`

#### Scenario: A page that reaches the start of the thread gives a null cursor

- **GIVEN** a thread of 2 turns
- **WHEN** the page read runs with a limit of 2 and no cursor
- **THEN** it returns the 2 turns and the cursor `null`

#### Scenario: A page holds the rows before the first turn start

- **GIVEN** a thread whose first rows are a host record, and 1 turn after them
- **WHEN** the page read runs with a limit of 2 and no cursor
- **THEN** it returns the group of the host record and the turn, and the cursor `null`

#### Scenario: A page holds each row of a multi-row turn

- **GIVEN** a thread whose newest turn holds a user row, assistant rows, tool rows, and a loop-synthesized nudge
- **WHEN** the page read runs with a limit of 1 and no cursor
- **THEN** the page holds each row of that turn, and the nudge does not start a turn

#### Scenario: The page read does not read the rows before its page

- **GIVEN** a thread of many turns whose oldest turn holds a row that the store cannot parse
- **WHEN** the page read runs for the newest page
- **THEN** it returns the page with no error, but `loadAll` gives an error for the same thread

#### Scenario: A page row carries the fields of the whole read

- **GIVEN** a closed chat turn stored with an author
- **WHEN** the page read returns that turn
- **THEN** each row of the turn is the same as the row that `loadAll` returns for it

#### Scenario: A cursor inside a turn gives that turn whole

- **GIVEN** a thread of 3 turns of 4 rows each, and a cursor that is the `seq` of the third row of the second turn
- **WHEN** the page read runs with a limit of 2 and that cursor
- **THEN** it returns the first turn and the whole second turn, and the cursor `null`

#### Scenario: A limit below 1 reads one turn

- **GIVEN** a thread of 3 turns
- **WHEN** the page read runs with a limit of 0 and no cursor
- **THEN** it returns the third turn only, and a cursor that is not `null`

#### Scenario: An empty thread gives an empty page

- **GIVEN** a thread with no rows
- **WHEN** the page read runs with no cursor
- **THEN** it returns no turn and the cursor `null`
