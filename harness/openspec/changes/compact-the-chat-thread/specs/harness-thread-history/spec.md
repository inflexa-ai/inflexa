## RENAMED Requirements

- FROM: `### Requirement: loadRecent windows by token budget`
- TO: `### Requirement: loadRecent gives the view of the latest compaction marker`

## MODIFIED Requirements

### Requirement: loadRecent gives the view of the latest compaction marker

`loadRecent(threadId, options)` MUST give the view of the thread. The view is a pure function of the stored messages. The loop uses the same function for each request of a run with a compaction policy (see the harness-agent-loop capability). `loadRecent` MUST NOT window by a token budget, and it MUST NOT window by a message count. The store deletes no row for a view. The stored markers decide what the view holds.

The view MUST obey this rule over the stored messages, in `seq` order:

- The head is the first turn of the thread when the option `keepFirstTurn` is set, and nothing when it is not set. The head ends at the next genuine user start, or at the first marker or exchange message.
- A message of a compaction exchange never joins the view.
- A summary marker becomes the front of the view, and it empties the body.
- A drop marker keeps the last turns of the body, by the count of turns that it carries. The drop marker itself never joins the view.
- A kept message of a drop loses its reasoning parts in the view. A message with no part left leaves the view. The stored row does not change.
- Each other message joins the body.
- The view is the head, then the latest summary marker, then the body.

Thus only the latest summary marker counts, and a drop keeps the last good summary in front. A message that the store holds after a drop marker keeps its reasoning. The view of a view is the same view.

A thread with no marker gives each stored message that is not a message of an exchange. The loop then compacts at the first request whose view exceeds its budget.

#### Scenario: A thread with no marker gives each message

- **GIVEN** a thread of 30 turns with no marker, whose total estimate exceeds 150,000 tokens
- **WHEN** `loadRecent` reads the thread
- **THEN** it gives each stored message in `seq` order

#### Scenario: Only the latest summary marker counts

- **GIVEN** a thread with two summary markers
- **WHEN** `loadRecent` reads the thread
- **THEN** the view starts with the second marker, and it holds no message that the store holds before that marker

#### Scenario: The exchange is not in the view

- **GIVEN** a thread whose last compaction stored an exchange and then a summary marker
- **WHEN** `loadRecent` reads the thread
- **THEN** no message of the view carries the exchange mark

#### Scenario: An exchange with no marker is not in the view

- **GIVEN** a thread whose last compaction stopped on an abort, with a stored exchange and no marker
- **WHEN** `loadRecent` reads the thread
- **THEN** the view holds each message of the thread except the messages of the exchange

#### Scenario: A report thread keeps its seed first

- **GIVEN** a report thread whose seed is its first turn, and a later summary marker
- **WHEN** `loadRecent` reads the thread with `keepFirstTurn`
- **THEN** the view starts with the seed, and then the summary marker

#### Scenario: A drop keeps the previous summary in front

- **GIVEN** a thread with a summary marker, later turns, and then a drop marker that keeps 2 turns
- **WHEN** `loadRecent` reads the thread
- **THEN** the view holds the summary marker, then the last 2 turns before the drop marker, then each message after the drop marker

#### Scenario: A kept message loses its thinking and a later message keeps it

- **GIVEN** a drop marker that keeps an assistant message with a reasoning part, and an assistant message with a reasoning part after the drop marker
- **WHEN** `loadRecent` reads the thread
- **THEN** the kept message has no reasoning part in the view, and the later message keeps its reasoning part
- **AND** each stored row is unchanged

#### Scenario: A retracted turn takes its marker with it

- **GIVEN** a tail turn that holds an exchange and a summary marker, after an earlier summary marker
- **WHEN** `retractLastTurn` removes the tail turn
- **THEN** `loadRecent` gives the view of the earlier summary marker

#### Scenario: The view of a view is the same view

- **GIVEN** the view of a thread with a summary marker and a later drop marker
- **WHEN** the view rule runs over that view
- **THEN** it gives the same messages, byte-identical

### Requirement: loadRecent returns a valid AI SDK model-message sequence

The view that `loadRecent` gives MUST be a valid AI SDK model-message sequence. It MUST NOT hold an orphan tool result, and it MUST NOT split a tool call from its result. A compaction starts only between two rounds, thus the messages after a marker start with no tool result. A drop keeps whole turns.

A turn boundary is a `user` message that a person sent. A `tool` message is not a boundary. A message that the harness synthesized is not a boundary either: the nudge after a truncated reply, a host record, a context record, a marker, and the request of an exchange.

The harness MUST mark such a message where it makes it. Each reader of a turn boundary MUST obey the same mark: the view, the display read, and the tail retract. A boundary in the middle of a turn splits that turn for all three.

The read MUST order the messages by the numeric `seq` column, never by a text form of it. A text sort puts `"10"` before `"2"`. It then reorders a thread past ten messages, and it splits a tool call from its result.

#### Scenario: The view after a marker starts with no tool result

- **GIVEN** a compaction that started after the tool message of a round
- **WHEN** `loadRecent` reads the thread
- **THEN** the first message after the summary marker is a context record, and each tool call of the view has its result

#### Scenario: A drop keeps whole turns

- **GIVEN** a drop marker that keeps 3 turns
- **WHEN** `loadRecent` reads the thread
- **THEN** the view holds each message of the 3 kept turns, and each tool call of the view has its result

#### Scenario: A thread past ten messages keeps numeric order

- **GIVEN** a thread with more than ten messages, whose tool call and tool result sit at `seq` 9 and `seq` 10
- **WHEN** `loadRecent` gives the view
- **THEN** the messages are in ascending numeric `seq` order, and the tool result comes directly after its tool call

### Requirement: loadRecent emits a thread-overflow metric

Each `loadRecent` call MUST record an OTel metric with two values: the total token count of the thread, and the count of the turns that the view leaves out. A turn is left out when the view holds none of its messages. The attribute `eviction` MUST be true when the view leaves out at least one turn.

#### Scenario: A compacted thread records the turns before the marker

- **GIVEN** a thread of 8 turns whose summary marker sits in the sixth turn
- **WHEN** `loadRecent` runs
- **THEN** the metric reports `eviction: true` and 5 left-out turns

#### Scenario: A thread with no marker records no eviction

- **GIVEN** a thread with no marker
- **WHEN** `loadRecent` runs
- **THEN** the metric reports `eviction: false` and 0 left-out turns

### Requirement: The reported rollup and the windowing token count are not interchangeable

The stored rollup and the `tokens` count of a row MUST stay two different measurements. The trigger of a compaction MUST read the token estimate of the view, and it MUST NOT read a rollup. `loadRecent` MUST NOT read a rollup. A rollup MUST NOT be presented as the token count of a row, and the `tokens` count MUST NOT be presented as reported usage.

The two share a unit, and neither replaces the other. The `tokens` count is an offline estimate of `js-tiktoken`, and the write computes it for each row, also for a row that no provider saw. Thus a budget never waits for a provider figure. The rollup is what a provider reported for a whole turn, and it is absent when no call reported. A budget on the rollup stops on each turn that has none. A report of `tokens` as usage gives an estimate as a billing fact.

#### Scenario: The trigger ignores the rollup

- **GIVEN** a thread whose assistant rows carry rollups far larger than their `tokens` counts
- **WHEN** the loop estimates the view
- **THEN** the estimate is the same as the estimate of the same thread with no rollup

#### Scenario: A thread with no rollup still compacts

- **GIVEN** a thread whose rows carry no rollup, and whose view exceeds the budget
- **WHEN** the loop estimates the view before a request
- **THEN** the loop compacts before it sends the request

## ADDED Requirements

### Requirement: The transcript read shows each compaction marker as a divider

The row of a compaction marker MUST carry the display projection of the marker. The projection is one `system` message with one `data-compaction` part at the final status of the compaction: `done` for a summary marker, and `failed` for a drop marker. The part carries the id, the tokens before and after, and the duration of the compaction.

A message of a compaction exchange MUST carry no display projection. The stored display vocabulary MUST accept the `data-compaction` part, because the read drops a part with an unknown key.

The transcript replay gives each stored envelope in order. Thus a reload shows a divider at the position of the marker, and it shows nothing of the exchange. A divider between two rounds of one turn separates them, thus the two rounds show as two assistant messages.

#### Scenario: A summary marker replays as a divider

- **GIVEN** a stored turn with one round, a compaction that ended with a summary marker, and one more round
- **WHEN** the transcript replay runs
- **THEN** it gives the user message, an assistant message, a `system` message with the `data-compaction` part at `done`, and then an assistant message

#### Scenario: A drop marker replays as a failed divider

- **GIVEN** a stored turn whose compaction ended with a drop marker
- **WHEN** the transcript replay runs
- **THEN** the divider carries the status `failed`, the tokens before and after, and the duration

#### Scenario: The exchange shows nothing

- **GIVEN** a stored compaction whose exchange holds a memory edit and a summary
- **WHEN** the transcript replay runs
- **THEN** no message of the replay holds the text of the summary or the call of the memory edit
