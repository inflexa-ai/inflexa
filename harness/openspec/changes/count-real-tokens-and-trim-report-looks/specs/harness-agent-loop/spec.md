## MODIFIED Requirements

### Requirement: The loop compacts the conversation when its view exceeds the budget

`RunAgentOptions` MUST accept an optional compaction policy, `compaction`. The policy holds these values:

- the budget of the view, by the measure of the view
- an optional turn-start budget, for the first request of the run
- the provider, the request, and the mask of the exchange
- the choice to keep the first turn in front of each view
- a function that gives the context records after a new marker

With a policy, each request of the run MUST send the view of its transcript, by the view rule of the harness-thread-history capability. Without a policy, each request sends the transcript, as before. The loop and the reader use one view function. Thus the next turn reads the prefix that the last request sent.

The loop MUST store the input tokens that the provider reports for a request on the assistant message of its reply (see the ai-sdk-message-storage capability). The figure is the total input of the request, with the cache reads. A reply with no reported figure carries no mark.

The measure of the view MUST start at an anchor. The anchor is the latest assistant message after the latest marker that carries the input tokens of its request. The measure is that figure, plus the estimate of the anchor and of each later message of the view. When the view holds no anchor, the measure is the estimate of the whole view. The estimate of a message is its `tokens` count (see the harness-thread-history capability).

Thus the measure holds the system prompt, the declared tools, and each picture at the count of the provider. A marker changes the prefix, thus a figure from before the latest marker does not count.

Before each request of the task segment, the loop MUST measure the view. Then it MUST select the first action of this list that applies:

1. A turn-start compaction. It applies only before the first request of the run, when the policy has a turn-start budget, and the measure exceeds that budget. The view must also hold a message before the user message of the current turn.
2. A mid-turn compaction. It applies when the measure exceeds the budget.
3. No compaction. The loop sends the request.

The loop measures the view only before a request. It sends a request only after each tool call of the last reply has its result. Thus a compaction starts between two rounds, and never inside one.

The loop MUST NOT start a compaction at these points:

- before a request of the wrap-up
- inside a continuation, the exchange of a compaction included
- before a request that continues a truncated reply
- after a compaction that failed in the same run
- after a compaction whose new view still exceeds the budget

A durable loop MUST pass no policy. The function of the records reads the database outside a step, and a replay runs the loop body again.

#### Scenario: A run with no policy sends its transcript

- **GIVEN** a run with no `compaction`
- **WHEN** the loop sends each request
- **THEN** the messages of each request are the transcript of the run, and no compaction runs

#### Scenario: A view within the budget does not compact

- **GIVEN** a run with a policy whose budget and turn-start budget exceed the measure of each view of the run
- **WHEN** the run completes
- **THEN** no exchange ran, and the transcript holds no marker

#### Scenario: A round that passes the budget compacts before the next request

- **GIVEN** a run with a budget of 1,000 tokens, whose first round appends a tool result of 2,000 tokens
- **WHEN** the loop prepares the second request
- **THEN** the exchange runs after the tool message of the first round, and the second request goes out after the exchange

#### Scenario: The first request can compact

- **GIVEN** a run with no turn-start budget, whose initial messages exceed the budget
- **WHEN** the loop prepares its first request
- **THEN** a mid-turn exchange runs first, and the first request of the task goes out with the new view

#### Scenario: A wrap-up request does not compact

- **GIVEN** a run that reaches its cap with a view over the budget
- **WHEN** the loop sends the wrap-up requests
- **THEN** no exchange runs before a wrap-up request

#### Scenario: A request after a truncated reply does not compact

- **GIVEN** a run whose reply is cut at the output limit with prose only, and whose view then exceeds the budget
- **WHEN** the loop sends the request that continues the reply
- **THEN** no exchange runs before that request

#### Scenario: The loop stores the input tokens of each request

- **GIVEN** a provider that reports 12,000 input tokens for a request
- **WHEN** the reply of that request lands in the transcript
- **THEN** the assistant message of the reply carries the figure 12,000 in the harness namespace

#### Scenario: The measure starts at the reported input tokens

- **GIVEN** a view whose last assistant message after the latest marker carries 180,000 input tokens, and a later tool message
- **WHEN** the loop measures the view
- **THEN** the measure is 180,000, plus the estimate of that assistant message and the estimate of the tool message

#### Scenario: A view with no reported figure uses the estimate

- **GIVEN** a view whose assistant messages carry no input tokens of a request
- **WHEN** the loop measures the view
- **THEN** the measure is the estimate of the whole view

#### Scenario: A figure from before the latest marker does not count

- **GIVEN** a view whose only assistant message with a figure is in a turn that a drop marker kept
- **WHEN** the loop measures the view
- **THEN** the measure is the estimate of the whole view

#### Scenario: A turn-start compaction runs before the first request

- **GIVEN** a policy with a turn-start budget of 150,000 and a budget of 200,000, and a view with an earlier turn whose measure is 160,000
- **WHEN** the loop prepares the first request
- **THEN** a turn-start compaction runs before the first request

#### Scenario: A view under the turn-start budget does not compact at the turn start

- **GIVEN** a policy with a turn-start budget of 150,000, and a view with an earlier turn whose measure is 140,000
- **WHEN** the loop prepares the first request
- **THEN** no exchange runs, and the first request goes out

#### Scenario: A later request compacts at the budget during the turn

- **GIVEN** a policy with a turn-start budget of 150,000 and a budget of 200,000, and a view whose measure is 210,000 after the first round
- **WHEN** the loop prepares the second request
- **THEN** a mid-turn compaction runs before the second request

#### Scenario: A turn with no earlier message uses the budget during the turn

- **GIVEN** a policy with a turn-start budget, and a view of the current turn alone, whose measure is between the two budgets
- **WHEN** the loop prepares the first request
- **THEN** no exchange runs, and the first request goes out

### Requirement: A compaction continues the conversation

A compaction MUST run its exchange as a continuation of a prefix of the current view (see the requirement "A continuation extends an existing conversation of an agent"). A mid-turn exchange continues the whole view. A turn-start exchange continues the view before the user message of the current turn. The previous turn sent that prefix, thus the exchange reads it from the cache.

The exchange MUST send the system prompt, the declared tools, the tool choice, the effort, and the cache policy of the run with no change. Thus the prefix is a cache hit, and each thinking block of the prefix stays valid.

The exchange MUST use these values:

- the provider of the policy
- the request of the policy, as a synthetic user message
- the mask of the policy
- a cap of 4 requests
- the step namespace `compaction-<n>`, where `<n>` counts the compactions of the run from 0
- the accounting agent id `<agent id>-compaction`

The provider of the policy is the provider of the conversation with no text stream to the surface. Thus the summary never streams to the surface as a reply. The accounting id gives the usage records and the token counters of the exchange their own agent id. It also gives the events of the exchange a deeper call path, thus a host shows them as sub-agent traffic.

The loop MUST mark each message of the exchange with the id of the compaction (see the ai-sdk-message-storage capability), and it MUST append the messages to its transcript. The summary is the text of the last reply of the exchange. The summary exists only when that reply ends the exchange with the finish reason `stop` and its text is not empty.

#### Scenario: The exchange extends the view

- **GIVEN** a run that does a mid-turn compaction before its third request
- **WHEN** the exchange sends its first request
- **THEN** the request carries the system prompt and the tools of the run, and its messages start with each message of the view, byte-identical

#### Scenario: A turn-start exchange extends the view before the turn

- **GIVEN** a run that does a turn-start compaction
- **WHEN** the exchange sends its first request
- **THEN** its messages are each message of the view before the user message of the current turn, byte-identical, and then the request of the policy

#### Scenario: The mask refuses a tool outside it

- **GIVEN** a policy whose mask lets only `update_working_memory` run
- **WHEN** the exchange calls `read_file`
- **THEN** `read_file` does not run, and the call gets the error result of the mask

#### Scenario: The summary does not stream

- **GIVEN** a policy whose provider drops each text delta
- **WHEN** the exchange replies with a summary
- **THEN** the `emit` of the run gets no text delta of the summary

#### Scenario: The exchange counts under its accounting id

- **GIVEN** a compaction of a run of the agent `conversation-agent`
- **WHEN** a call of the exchange completes with usage
- **THEN** the usage record and the token counters carry the agent id `conversation-agent-compaction`

#### Scenario: The messages of the exchange carry the mark

- **GIVEN** an exchange of one memory edit and one summary
- **WHEN** the run returns
- **THEN** the request, the assistant messages, and the tool message of the exchange carry the id of the compaction

### Requirement: A compaction ends with a summary marker and a new view

When the exchange gives a summary, the loop MUST append a summary marker after the exchange. The marker is a synthetic user message. Its text is the tag `[Conversation Summary]`, a new line, and the summary.

The marker MUST carry the count of the turns that the new view keeps after the summary: 1 for a turn-start compaction, and 0 for a mid-turn compaction. The exchange of a turn-start compaction did not see the current turn. Thus the new view keeps that turn after the summary (see the harness-thread-history capability).

Then the loop MUST call the function of the records with the new view: the head, the marker, and the kept turn. It MUST append the records that the function gives after the marker. The next request MUST send the new view, and each later message joins it.

The loop MUST give the round sink two rounds, in this order:

1. the messages of the exchange, when the exchange ends
2. the marker and its records

Thus the store holds the marker before a request sends it. The exchange is one round, because no later request sends a message of the exchange.

A second compaction MUST continue the view that starts at the previous summary. Thus the model folds the previous summary into the new summary, and only the latest summary marker counts.

#### Scenario: The view restarts at the marker

- **GIVEN** a run that does a mid-turn compaction before its third request
- **WHEN** the loop sends the third request
- **THEN** its messages are the summary marker and then the records, and they hold no message of the exchange or of the first two rounds

#### Scenario: A turn-start summary keeps the user message of the turn

- **GIVEN** a run that does a turn-start compaction with a summary
- **WHEN** the loop sends the first request of the task
- **THEN** its messages are the summary marker, the user message of the current turn, and then the records
- **AND** the marker carries 1 kept turn

#### Scenario: A second compaction continues from the first summary

- **GIVEN** a run that compacts two times
- **WHEN** the second exchange sends its first request
- **THEN** its messages start with the first summary marker, and they hold no message of the first exchange

#### Scenario: The rounds and the result agree

- **GIVEN** a run with a round sink that compacts one time
- **WHEN** the run returns
- **THEN** the sink got the exchange as one round and then the marker with its records as one round
- **AND** the initial messages and then each round, in order, equal the messages of the result

#### Scenario: A run that keeps its first turn keeps it in front

- **GIVEN** a policy that keeps the first turn, and a run whose first turn is a seed
- **WHEN** the loop sends the request after the compaction
- **THEN** its messages start with the seed, and then the summary marker

### Requirement: The loop reports each compaction as a data part

The loop MUST emit the progress of each compaction through its `emit`, as a `data-compaction` part with the source of the run. The part carries these fields:

- `id`: one id for each compaction
- `status`: `running`, `done`, or `failed`
- `trigger`: `turn-start` or `mid-turn`
- `tokensBefore`: the measure of the view before the compaction
- `tokensAfter`: the estimate of the new view with its records, when a marker exists
- `durationMs`: the time of the compaction, on a terminal status

The loop MUST emit `running` before the exchange. It MUST emit one terminal status under the same id: `done` after a summary marker, or `failed` after a drop marker, an abort, or a throw out of the exchange. A throw then passes through the loop.

The part registry MUST list `data-compaction` with the emitter `conversation`, the consumer `conversation`, `transient: true`, and `reconciling: true`. The display recorder does not store a transient part. The stored marker carries the divider (see the harness-thread-history capability).

The loop MUST log each compaction through its `Logger`: at `info` for a summary, and at `warn` for a drop. The record carries the id, the trigger, the two token figures, the duration, and the count of the kept turns of a drop. A drop for a refusal also carries the HTTP status and the error text of the provider. The warn for a new view that still exceeds the budget also carries the trigger.

#### Scenario: A summary emits running and then done

- **GIVEN** a run that compacts one time with a summary
- **WHEN** the run returns
- **THEN** the `emit` got one `data-compaction` part with `running` and `tokensBefore`, and then one with `done`, `tokensAfter`, and `durationMs`, under the same id

#### Scenario: A drop emits failed with the tokens after

- **GIVEN** a run whose exchange fails
- **WHEN** the loop appends the drop marker
- **THEN** the terminal part carries `failed`, `tokensAfter`, and `durationMs`

#### Scenario: The part and the log name the trigger

- **GIVEN** a run that does a turn-start compaction with a summary
- **WHEN** the run returns
- **THEN** each `data-compaction` part of the compaction carries the trigger `turn-start`
- **AND** the `info` record of the compaction carries the same trigger

#### Scenario: The part carries the source of the run

- **GIVEN** a root loop with the call path `["tui-chat"]`
- **WHEN** the loop emits a `data-compaction` part
- **THEN** the source of the part carries the call path of the run, not the call path of the exchange

#### Scenario: The registry lists the part

- **WHEN** a reader reads `PART_REGISTRY["data-compaction"]`
- **THEN** it gives the emitter `conversation`, the consumer `conversation`, `transient: true`, and `reconciling: true`
