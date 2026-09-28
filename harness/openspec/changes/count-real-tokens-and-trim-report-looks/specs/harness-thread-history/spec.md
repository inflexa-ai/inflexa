## MODIFIED Requirements

### Requirement: The reported rollup and the windowing token count are not interchangeable

The stored rollup, the `tokens` count of a row, and the input tokens of a request MUST stay three different measurements. The check of a compaction budget MUST read the input tokens of the last request (see the harness-agent-loop capability). It MUST NOT read a rollup, and it MUST NOT read a `tokens` count. `loadRecent` MUST NOT read a rollup.

A rollup and the input tokens of a request MUST NOT be presented as the token count of a row. The `tokens` count MUST NOT be presented as reported usage.

The three share a unit, and none replaces another:

- The `tokens` count is an offline estimate of `js-tiktoken`. The write computes it for each row, also for a row that no provider saw. The thread-overflow metric adds it.
- The input tokens of a request are what the provider reported for the whole prefix of one request. They hold the system prompt, the tools, and the pictures at the count of the provider. Thus the check reads them.
- The rollup is what a provider reported for a whole turn. It adds the input of each request of the turn, and it is absent when no call reported. A budget on the rollup counts one prefix many times.

#### Scenario: Windowing ignores the rollup

- **GIVEN** a thread whose assistant rows carry rollups far larger than their `tokens` counts
- **WHEN** `loadRecent` gives the view
- **THEN** the view is the same as the view of the same thread with no rollup

#### Scenario: A row with no rollup still windows

- **GIVEN** a thread whose rows carry no rollup
- **WHEN** `loadRecent` gives the view
- **THEN** the markers decide the view, the same as for a thread whose rows carry rollups

#### Scenario: The check ignores the rollup and the tokens column

- **GIVEN** a thread whose rollups and whose `tokens` counts sum above the budget, and whose last reply carries input tokens under the budget
- **WHEN** the loop compares the figure with the budget before a request
- **THEN** no compaction runs

#### Scenario: A thread with no rollup still compacts

- **GIVEN** a thread whose rows carry no rollup, and whose last reply carries input tokens over the budget
- **WHEN** the loop compares the figure with the budget before a request
- **THEN** the loop compacts before it sends the request

#### Scenario: The input tokens of a request do not change the tokens column

- **GIVEN** an assistant message that carries 180,000 input tokens of its request
- **WHEN** the store appends the message
- **THEN** the `tokens` column of its row holds the estimate of the content of the message

### Requirement: The transcript read shows each compaction marker as a divider

The row of a compaction marker MUST carry the display projection of the marker. The projection is one `system` message with one `data-compaction` part at the status `done`. The part carries the id, `tokensBefore`, and the duration of the compaction. It also carries the trigger when the marker carries one. It carries no `tokensAfter`.

A compaction with no summary writes no marker. Thus a reload shows no divider for it. A divider that an older harness stored keeps its projection.

A message of a compaction exchange MUST carry no display projection. The stored display vocabulary MUST accept the `data-compaction` part, because the read drops a part with an unknown key.

The transcript replay gives each stored envelope in order. Thus a reload shows a divider at the position of the marker, and it shows nothing of the exchange. A divider between two rounds of one turn separates them, thus the two rounds show as two assistant messages.

#### Scenario: A summary marker replays as a divider

- **GIVEN** a stored turn with one round, a compaction that ended with a summary marker, and one more round
- **WHEN** the transcript replay runs
- **THEN** it gives the user message, an assistant message, a `system` message with the `data-compaction` part at `done`, and then an assistant message

#### Scenario: A compaction with no summary shows no divider

- **GIVEN** a stored turn whose compaction gave no summary
- **WHEN** the transcript replay runs
- **THEN** the replay holds no divider of that compaction, and no message of its exchange

#### Scenario: The divider carries the trigger

- **GIVEN** a stored summary marker with the trigger `turn-start`
- **WHEN** the transcript replay runs
- **THEN** the `data-compaction` part of the divider carries the trigger `turn-start`

#### Scenario: The exchange shows nothing

- **GIVEN** a stored compaction whose exchange holds a memory edit and a summary
- **WHEN** the transcript replay runs
- **THEN** no message of the replay holds the text of the summary or the call of the memory edit
