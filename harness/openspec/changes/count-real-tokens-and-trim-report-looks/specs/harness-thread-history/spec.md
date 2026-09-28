## MODIFIED Requirements

### Requirement: loadRecent gives the view of the latest compaction marker

`loadRecent(threadId, options)` MUST give the view of the thread. The view is a pure function of the stored messages. The loop uses the same function for each request of a run with a compaction policy (see the harness-agent-loop capability). `loadRecent` MUST NOT window by a token budget, and it MUST NOT window by a message count. The store deletes no row for a view. The stored markers decide what the view holds.

The view MUST obey this rule over the stored messages, in `seq` order:

- The head is the first turn of the thread when the option `keepFirstTurn` is set, and nothing when it is not set. The head ends at the next genuine user start, or at the first marker or exchange message.
- A message of a compaction exchange never joins the view.
- A summary marker becomes the front of the view. It keeps the last turns of the body, by the count of kept turns that it carries, and it removes the rest of the body. A summary marker with no count keeps no turn.
- A kept turn of a summary marker loses its context records in the view, because the records after the marker give the current context.
- A drop marker keeps the last turns of the body, by the count of turns that it carries. The drop marker itself never joins the view.
- A kept message of a drop marker or of a summary marker loses its reasoning parts in the view. A message with no part left leaves the view. The stored row does not change.
- Each other message joins the body.
- The view is the head, then the latest summary marker, then the body.

Thus only the latest summary marker counts, and a drop keeps the last good summary in front. A message that the store holds after a marker keeps its reasoning. The view of a view is the same view.

A thread with no marker gives each stored message that is not a message of an exchange. The loop then compacts at the first request whose view exceeds its budget.

#### Scenario: A thread with no marker gives each message

- **GIVEN** a thread of 30 turns with no marker, whose total estimate exceeds 150,000 tokens
- **WHEN** `loadRecent` reads the thread
- **THEN** it gives each stored message in `seq` order

#### Scenario: Only the latest summary marker counts

- **GIVEN** a thread with two summary markers
- **WHEN** `loadRecent` reads the thread
- **THEN** the view starts with the second marker, and it holds no message that the store holds before that marker

#### Scenario: A summary keeps its kept turn after the summary

- **GIVEN** a turn that holds a user message, a context record, and an assistant message with a text part and a reasoning part
- **AND** a later summary marker that keeps 1 turn, and a new context record after the marker
- **WHEN** `loadRecent` reads the thread
- **THEN** the view is the summary marker, the user message, the assistant message with no reasoning part, and the new context record
- **AND** the old context record is not in the view

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

#### Scenario: The view of a view with a kept turn is the same view

- **GIVEN** the view of a thread whose summary marker keeps 1 turn
- **WHEN** the view rule runs over that view
- **THEN** it gives the same messages, byte-identical

### Requirement: The reported rollup and the windowing token count are not interchangeable

The stored rollup, the `tokens` count of a row, and the input tokens of a request MUST stay three different measurements. The trigger of a compaction MUST read the measure of the view (see the harness-agent-loop capability). It MUST NOT read a rollup. `loadRecent` MUST NOT read a rollup.

A rollup and the input tokens of a request MUST NOT be presented as the token count of a row. The `tokens` count MUST NOT be presented as reported usage.

The three share a unit, and none replaces another:

- The `tokens` count is an offline estimate. The write computes it for each row, also for a row that no provider saw. Thus a view always has a measure, also with no provider figure.
- The input tokens of a request are what the provider reported for the whole prefix of one request. The measure starts at the latest such figure, because the figure holds the system prompt, the tools, and the pictures.
- The rollup is what a provider reported for a whole turn. It adds the input of each request of the turn, and it is absent when no call reported. A budget on the rollup counts one prefix many times, and it stops on each turn that has no rollup.

#### Scenario: Windowing ignores the rollup

- **GIVEN** a thread whose assistant rows carry rollups far larger than their `tokens` counts
- **WHEN** `loadRecent` gives the view
- **THEN** the view is the same as the view of the same thread with no rollup

#### Scenario: A row with no rollup still windows

- **GIVEN** a thread whose rows carry no rollup
- **WHEN** `loadRecent` gives the view
- **THEN** the markers decide the view, the same as for a thread whose rows carry rollups

#### Scenario: The trigger ignores the rollup

- **GIVEN** a thread whose assistant rows carry rollups far larger than their `tokens` counts, and no input tokens of a request
- **WHEN** the loop measures the view
- **THEN** the measure is the same as the measure of the same thread with no rollup

#### Scenario: A thread with no rollup still compacts

- **GIVEN** a thread whose rows carry no rollup and no input tokens of a request, and whose estimate exceeds the budget
- **WHEN** the loop measures the view before a request
- **THEN** the loop compacts before it sends the request

#### Scenario: The input tokens of a request do not change the tokens column

- **GIVEN** an assistant message that carries 180,000 input tokens of its request
- **WHEN** the store appends the message
- **THEN** the `tokens` column of its row holds the estimate of the content of the message

### Requirement: The transcript read shows each compaction marker as a divider

The row of a compaction marker MUST carry the display projection of the marker. The projection is one `system` message with one `data-compaction` part at the final status of the compaction: `done` for a summary marker, and `failed` for a drop marker. The part carries the id, the tokens before and after, and the duration of the compaction. It also carries the trigger when the marker carries one. A marker from before the trigger carries none, and its divider carries none.

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

#### Scenario: The divider carries the trigger

- **GIVEN** a stored summary marker with the trigger `turn-start`
- **WHEN** the transcript replay runs
- **THEN** the `data-compaction` part of the divider carries the trigger `turn-start`

#### Scenario: The exchange shows nothing

- **GIVEN** a stored compaction whose exchange holds a memory edit and a summary
- **WHEN** the transcript replay runs
- **THEN** no message of the replay holds the text of the summary or the call of the memory edit

## ADDED Requirements

### Requirement: The token estimate counts a picture by its pixel area

The `tokens` count of a row and the estimate of a view MUST use one count. The count MUST encode the text of a message with `js-tiktoken`. It MUST count each picture by its pixel area: `ceil(width × height / 750)` tokens, the rule that Anthropic publishes.

The size MUST come from the header of the image data. The reader knows PNG, JPEG, GIF, and WebP, and it decodes no pixel. The count MUST find a picture in each place where a picture can ride:

- an `image` block
- a `file` block with an image media type
- an image in the `content` output of a tool result

A picture whose header gives no size MUST count as 1,600 tokens. A picture that a URL names gives no header, thus it counts the same. The bytes of a picture never join the encoded text. A file that is not a picture counts as 0, because the provider bills it at its own rate.

#### Scenario: A picture counts by its area

- **GIVEN** a tool result with one PNG picture of 720 by 2000 pixels
- **WHEN** the count runs over the message
- **THEN** the picture counts as 1,920 tokens

#### Scenario: A picture of unknown size counts by the fallback

- **GIVEN** a tool result with one picture whose data has no header that the reader knows
- **WHEN** the count runs over the message
- **THEN** the picture counts as 1,600 tokens, and not by the length of its bytes

#### Scenario: A file that is not a picture counts as 0

- **GIVEN** a message with one PDF file block
- **WHEN** the count runs over the message
- **THEN** the file counts as 0 tokens
