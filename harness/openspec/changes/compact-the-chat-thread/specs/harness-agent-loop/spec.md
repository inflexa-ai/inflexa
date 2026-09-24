## ADDED Requirements

### Requirement: The loop compacts the conversation when its view exceeds the budget

`RunAgentOptions` MUST accept an optional compaction policy, `compaction`. The policy holds these values:

- the budget of the view, in estimated tokens
- the provider, the request, and the mask of the exchange
- the choice to keep the first turn in front of each view
- a function that gives the context records after a new marker

With a policy, each request of the run MUST send the view of its transcript, by the view rule of the harness-thread-history capability. Without a policy, each request sends the transcript, as before. The loop and the reader use one view function. Thus the next turn reads the prefix that the last request sent.

Before each request of the task segment, the loop MUST estimate the view. The estimate is the sum of the token estimates of the messages of the view. The function that computes the `tokens` column of a row gives each estimate. The system prompt and the declared tools are outside the budget. When the estimate exceeds the budget, the loop MUST compact before it sends the request.

The loop estimates the view only before a request. It sends a request only after each tool call of the last reply has its result. Thus a compaction starts between two rounds, and never inside one.

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

- **GIVEN** a run with a policy whose budget exceeds the estimate of each view of the run
- **WHEN** the run completes
- **THEN** no exchange ran, and the transcript holds no marker

#### Scenario: A round that passes the budget compacts before the next request

- **GIVEN** a run with a budget of 1,000 tokens, whose first round appends a tool result of 2,000 tokens
- **WHEN** the loop prepares the second request
- **THEN** the exchange runs after the tool message of the first round, and the second request goes out after the exchange

#### Scenario: The first request can compact

- **GIVEN** a run whose initial messages exceed the budget
- **WHEN** the loop prepares its first request
- **THEN** the exchange runs first, and the first request of the task goes out with the new view

#### Scenario: A wrap-up request does not compact

- **GIVEN** a run that reaches its cap with a view over the budget
- **WHEN** the loop sends the wrap-up requests
- **THEN** no exchange runs before a wrap-up request

#### Scenario: A request after a truncated reply does not compact

- **GIVEN** a run whose reply is cut at the output limit with prose only, and whose view then exceeds the budget
- **WHEN** the loop sends the request that continues the reply
- **THEN** no exchange runs before that request

### Requirement: A compaction continues the conversation

A compaction MUST run its exchange as a continuation of the current view (see the requirement "A continuation extends an existing conversation of an agent"). The exchange MUST send the system prompt, the declared tools, the tool choice, the effort, and the cache policy of the run with no change. Thus the view is a cache hit, and each thinking block of the view stays valid.

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

- **GIVEN** a run that compacts before its third request
- **WHEN** the exchange sends its first request
- **THEN** the request carries the system prompt and the tools of the run, and its messages start with each message of the view, byte-identical

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

Then the loop MUST call the function of the records with the new view: the head, and then the marker. It MUST append the records that the function gives after the marker. The next request MUST send the new view, and each later message joins it.

The loop MUST give the round sink two rounds, in this order:

1. the messages of the exchange, when the exchange ends
2. the marker and its records

Thus the store holds the marker before a request sends it. The exchange is one round, because no later request sends a message of the exchange.

A second compaction MUST continue the view that starts at the previous summary. Thus the model folds the previous summary into the new summary, and only the latest summary marker counts.

#### Scenario: The view restarts at the marker

- **GIVEN** a run that compacts before its third request
- **WHEN** the loop sends the third request
- **THEN** its messages are the summary marker and then the records, and they hold no message of the exchange or of the first two rounds

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

### Requirement: A failed compaction drops the oldest turns

The loop MUST append a drop marker in place of a summary marker only when the exchange itself cannot give a summary. A drop is a lasting change of the view. The exchange cannot give a summary in these conditions:

- The exchange gives no text within its cap of 4 requests. The last reply has no text, or it ends with a finish reason other than `stop`.
- The provider refuses a request of the exchange for its content: a `provider` error with the HTTP status `400` or `413`. A request that is too long for the context window gets such a refusal.

A refusal of the request MUST end the exchange with no summary, and it MUST NOT throw out of the run. The exchange continues a view that the provider accepted one request earlier, thus such a refusal is almost always a length refusal. The status does not say why, thus the warn of the drop MUST give the HTTP status and the error text of the provider. Thus a false drop is visible.

The drop marker MUST keep the last good summary in front: the view keeps its head and its latest summary marker, when one exists. The drop marker MUST carry the count of the turns that the view keeps. The loop MUST count them from the newest turn of the body. It keeps the newest turn, and it adds each older turn while the estimate of the view stays within the budget.

A kept message that the harness made before the drop marker loses its reasoning parts in the view. The signature of each such part binds the prefix that the drop changed. A message after the drop marker keeps its reasoning.

After the drop marker, the loop MUST append the records that the function of the records gives. It MUST give the sink the same two rounds as for a summary. The loop MUST NOT start another compaction in the run.

Each other end of the exchange MUST NOT drop:

- An abort. When the exchange ends with the finish reason `aborted`, the loop MUST store the exchange and no marker. Then it MUST end the run with the same finish reason.
- An `auth` error, a `suspend` error, a transient provider error that the retry envelope did not fix, and each other error. The error MUST go up out of the run, the same as an error of a task request, and the loop stores no marker.

The next turn then tries the compaction again, because the thread holds no new marker.

#### Scenario: A refused request drops the oldest turns and keeps the previous summary

- **GIVEN** a run whose view starts at a summary marker, and whose exchange gets a `provider` error with the HTTP status `400`
- **WHEN** the loop ends the exchange
- **THEN** the transcript holds a drop marker, the next request starts with the same summary marker, and the run does not throw

#### Scenario: An exchange with no summary drops

- **GIVEN** an exchange whose model calls `update_working_memory` in each of its 4 replies
- **WHEN** the exchange reaches its cap
- **THEN** the loop appends a drop marker, and no summary marker

#### Scenario: A kept message loses its thinking

- **GIVEN** a drop marker that keeps a turn whose assistant message holds a reasoning part
- **WHEN** the loop sends the next request
- **THEN** that message has no reasoning part in the request, and a reply after the drop marker keeps its reasoning in each later request

#### Scenario: No second compaction after a drop

- **GIVEN** a run whose first compaction dropped turns, and whose view later exceeds the budget again
- **WHEN** the loop sends each later request of the run
- **THEN** no second exchange runs

#### Scenario: An abort stores no marker

- **GIVEN** a run whose signal aborts during the exchange
- **WHEN** the run returns
- **THEN** `finish.reason` is `"aborted"`, the transcript ends with the messages of the exchange, and it holds no new marker

#### Scenario: A drop for a refusal is visible in the log

- **GIVEN** an exchange whose request gets a `provider` error with the HTTP status `400`
- **WHEN** the loop appends the drop marker
- **THEN** a `warn` record carries the status `400` and the error text of the provider as fields

#### Scenario: An auth error goes up

- **GIVEN** an exchange whose model call gets an `auth` error
- **WHEN** the loop runs the exchange
- **THEN** the run throws that error, the transcript holds no new marker, and the part carries `failed`

#### Scenario: A transient error goes up

- **GIVEN** an exchange whose model call gets a retryable `provider` error after the retries of the provider
- **WHEN** the loop runs the exchange
- **THEN** the run throws that error, and the transcript holds no new marker

### Requirement: The loop reports each compaction as a data part

The loop MUST emit the progress of each compaction through its `emit`, as a `data-compaction` part with the source of the run. The part carries these fields:

- `id`: one id for each compaction
- `status`: `running`, `done`, or `failed`
- `tokensBefore`: the estimate of the view before the compaction
- `tokensAfter`: the estimate of the new view, when a marker exists
- `durationMs`: the time of the compaction, on a terminal status

The loop MUST emit `running` before the exchange. It MUST emit one terminal status under the same id: `done` after a summary marker, or `failed` after a drop marker, an abort, or a throw out of the exchange. A throw then passes through the loop.

The part registry MUST list `data-compaction` with the emitter `conversation`, the consumer `conversation`, `transient: true`, and `reconciling: true`. The display recorder does not store a transient part. The stored marker carries the divider (see the harness-thread-history capability).

The loop MUST log each compaction through its `Logger`: at `info` for a summary, and at `warn` for a drop. The record carries the id, the two estimates, the duration, and the count of the kept turns of a drop. A drop for a refusal also carries the HTTP status and the error text of the provider.

#### Scenario: A summary emits running and then done

- **GIVEN** a run that compacts one time with a summary
- **WHEN** the run returns
- **THEN** the `emit` got one `data-compaction` part with `running` and `tokensBefore`, and then one with `done`, `tokensAfter`, and `durationMs`, under the same id

#### Scenario: A drop emits failed with the tokens after

- **GIVEN** a run whose exchange fails
- **WHEN** the loop appends the drop marker
- **THEN** the terminal part carries `failed`, `tokensAfter`, and `durationMs`

#### Scenario: The part carries the source of the run

- **GIVEN** a root loop with the call path `["tui-chat"]`
- **WHEN** the loop emits a `data-compaction` part
- **THEN** the source of the part carries the call path of the run, not the call path of the exchange

#### Scenario: The registry lists the part

- **WHEN** a reader reads `PART_REGISTRY["data-compaction"]`
- **THEN** it gives the emitter `conversation`, the consumer `conversation`, `transient: true`, and `reconciling: true`
