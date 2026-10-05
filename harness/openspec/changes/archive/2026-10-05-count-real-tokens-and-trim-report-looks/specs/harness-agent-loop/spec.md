## RENAMED Requirements

- FROM: `### Requirement: A failed compaction drops the oldest turns`
- TO: `### Requirement: A compaction with no summary leaves the view unchanged`

## MODIFIED Requirements

### Requirement: A compaction with no summary leaves the view unchanged

When the exchange gives no summary, the loop MUST append no marker and no records. The view does not change. The exchange gives no summary in these conditions:

- The exchange gives no text within its cap of 4 requests. The last reply has no text, or it ends with a finish reason other than `stop`.
- The provider refuses a request of the exchange for its content: a `provider` error with the HTTP status `400` or `413`. A request that is too long for the context window gets such a refusal.

A refusal of the request MUST end the exchange with no summary, and it MUST NOT throw out of the run. The status does not say why, thus the log record MUST give the HTTP status and the error text of the provider.

The loop MUST store the exchange, the same as after a summary. It MUST emit the part with the status `failed`, and it MUST log the failure at `error` level. Thus the log alert on the error lines of a workload sees each failed compaction. Then the loop MUST NOT start a compaction again in the run.

The run continues with the same view. When the context window then refuses a request, the turn fails, and the person continues with a new turn. The next turn tries the compaction again, because the thread holds no new marker.

The loop writes no drop marker. The view still obeys a drop marker that an earlier harness stored (see the harness-thread-history capability).

Each other end of the exchange MUST also leave the view unchanged:

- An abort. When the exchange ends with the finish reason `aborted`, the loop MUST store the exchange and no marker. Then it MUST end the run with the same finish reason.
- An `auth` error, a `suspend` error, a transient provider error that the retry envelope did not fix, and each other error. The error MUST go up out of the run, the same as an error of a task request, and the loop stores no marker.

#### Scenario: A refused request leaves the view unchanged

- **GIVEN** a run whose view starts at a summary marker, and whose exchange gets a `provider` error with the HTTP status `400`
- **WHEN** the loop ends the exchange
- **THEN** the transcript holds no new marker, the next request sends the same view, and the run does not throw

#### Scenario: An exchange with no summary adds no marker

- **GIVEN** an exchange whose model calls `update_working_memory` in each of its 4 replies
- **WHEN** the exchange reaches its cap
- **THEN** the loop appends no marker and no record, and the terminal part carries `failed`

#### Scenario: No second compaction after a compaction with no summary

- **GIVEN** a run whose first compaction gave no summary, and whose later request reports input tokens over the budget
- **WHEN** the loop sends each later request of the run
- **THEN** no second exchange runs

#### Scenario: A failed compaction logs an error

- **GIVEN** an exchange whose request gets a `provider` error with the HTTP status `400`
- **WHEN** the exchange ends
- **THEN** an `error` record carries the status `400` and the error text of the provider as fields

#### Scenario: An abort stores no marker

- **GIVEN** a run whose signal aborts during the exchange
- **WHEN** the run returns
- **THEN** `finish.reason` is `"aborted"`, the transcript ends with the messages of the exchange, and it holds no new marker

#### Scenario: An auth error goes up

- **GIVEN** an exchange whose model call gets an `auth` error
- **WHEN** the loop runs the exchange
- **THEN** the run throws that error, the transcript holds no new marker, and the part carries `failed`

#### Scenario: A transient error goes up

- **GIVEN** an exchange whose model call gets a retryable `provider` error after the retries of the provider
- **WHEN** the loop runs the exchange
- **THEN** the run throws that error, and the transcript holds no new marker

### Requirement: The loop compacts the conversation when its view exceeds the budget

`RunAgentOptions` MUST accept an optional compaction policy, `compaction`. The policy holds these values:

- the rules of the agent (`CompactionRules`): the budget during a turn, and an optional turn-start budget, in the input tokens of a request
- the provider, the request, and the mask of the exchange
- the choice to keep the first turn in front of each view
- a function that gives the context records after a new marker

With a policy, each request of the run MUST send the view of its transcript, by the view rule of the harness-thread-history capability. Without a policy, each request sends the transcript, as before. The loop and the reader use one view function. Thus the next turn reads the prefix that the last request sent.

The loop MUST store the input tokens that the provider reports for a request on the assistant message of its reply (see the ai-sdk-message-storage capability). The figure is the total input of the request, with the cache reads. A reply with no reported figure carries no mark.

The check of a budget MUST read the latest figure of the transcript: the input tokens of the latest assistant message that carries them. A compaction marker after that message gives no figure. With no figure, the loop MUST NOT compact, and it sends the request. The next request reports a figure, and the check before the request after it reads that figure. The loop makes no local estimate for the check.

The figure holds the system prompt, the declared tools, and each picture at the count of the provider. But the check sees the tool results of the last round one request late. The budgets are far below the context window, thus a compaction starts at most one request later.

Before each request of the task segment, the loop MUST compare the latest figure with the budget. When the figure exceeds the budget, the loop MUST do a mid-turn compaction before it sends the request. The loop compares only before a request. It sends a request only after each tool call of the last reply has its result. Thus a compaction starts between two rounds, and never inside one.

After a summary, the first figure of a request shows if the summary brought the conversation under the budget. When that figure still exceeds the budget, the loop MUST log a `warn` with the figure and the budget. Then it MUST NOT start a compaction again in the run.

The loop MUST NOT start a mid-turn compaction at these points:

- before a request of the wrap-up
- inside a continuation, the exchange of a compaction included
- before a request that continues a truncated reply
- after a compaction with no summary in the same run
- after a summary whose first later figure still exceeded the budget

A durable loop MUST pass no policy. The function of the records reads the database outside a step, and a replay runs the loop body again.

#### Scenario: A run with no policy sends its transcript

- **GIVEN** a run with no `compaction`
- **WHEN** the loop sends each request
- **THEN** the messages of each request are the transcript of the run, and no compaction runs

#### Scenario: A figure within the budget does not compact

- **GIVEN** a run with a policy whose budget and turn-start budget exceed each figure of the run
- **WHEN** the run completes
- **THEN** no exchange ran, and the transcript holds no marker

#### Scenario: A request that passes the budget compacts before the next request

- **GIVEN** a run with a budget of 1,000 tokens, whose first request reports 2,000 input tokens
- **WHEN** the loop prepares the second request
- **THEN** the exchange runs after the tool message of the first round, and the second request goes out after the exchange

#### Scenario: A large tool result compacts one request late

- **GIVEN** a run with a budget of 1,000 tokens, whose first request reports 800 input tokens, and whose first round appends a tool result of 2,000 tokens
- **WHEN** the loop prepares the second request
- **THEN** no exchange runs, and the second request goes out
- **AND** when the second request reports more than 1,000 input tokens, the exchange runs before the third request

#### Scenario: The first request can compact

- **GIVEN** a run with no turn-start budget, whose initial messages end after a reply that carries input tokens over the budget
- **WHEN** the loop prepares its first request
- **THEN** a mid-turn exchange runs first, and the first request of the task goes out with the new view

#### Scenario: A transcript with no figure does not compact

- **GIVEN** a run with a policy, whose initial messages carry no input tokens of a request
- **WHEN** the loop prepares its first request
- **THEN** no exchange runs, and the first request goes out

#### Scenario: A marker after the latest figure stops the check

- **GIVEN** a run whose transcript ends with a summary marker and its records, after a reply that carries 300,000 input tokens
- **WHEN** the loop prepares the next request
- **THEN** no exchange runs, and the request goes out

#### Scenario: A summary that leaves the conversation over the budget stops the compaction

- **GIVEN** a run with a budget of 200,000 tokens, whose mid-turn compaction gives a summary, and whose first request after the summary reports 210,000 input tokens
- **WHEN** the loop prepares the next request
- **THEN** no exchange runs, and the loop logs a `warn` with the figure and the budget
- **AND** no later request of the run compacts

#### Scenario: A wrap-up request does not compact

- **GIVEN** a run that reaches its cap with a figure over the budget
- **WHEN** the loop sends the wrap-up requests
- **THEN** no exchange runs before a wrap-up request

#### Scenario: A request after a truncated reply does not compact

- **GIVEN** a run whose reply is cut at the output limit with prose only, and whose request reported input tokens over the budget
- **WHEN** the loop sends the request that continues the reply
- **THEN** no exchange runs before that request

#### Scenario: The loop stores the input tokens of each request

- **GIVEN** a provider that reports 12,000 input tokens for a request
- **WHEN** the reply of that request lands in the transcript
- **THEN** the assistant message of the reply carries the figure 12,000 in the harness namespace

#### Scenario: A later request compacts at the budget during the turn

- **GIVEN** a policy with a turn-start budget of 150,000 and a budget of 200,000, and a first request that reports 210,000 input tokens
- **WHEN** the loop prepares the second request
- **THEN** a mid-turn compaction runs before the second request

### Requirement: The loop reports each compaction as a data part

The loop MUST emit the progress of each compaction through its `emit`, as a `data-compaction` part with the source of the run. The part carries these fields:

- `id`: one id for each compaction
- `status`: `running`, then `done` or `failed`
- `trigger`: `turn-start` or `mid-turn`
- `tokensBefore`: the input tokens of the last request before the compaction
- `durationMs`: the time of the compaction, on a terminal status

The loop MUST emit `running` before the exchange. It MUST emit one terminal status under the same id: `done` after a summary marker, or `failed` when the view did not change. The view does not change after an exchange with no summary, an abort, or a throw out of the exchange. A throw then passes through the loop.

The loop MUST NOT emit `tokensAfter`. No figure of the new view exists before the next request. The field stays optional in `CompactionPart` only for a part that an older harness stored.

The part registry MUST list `data-compaction` with the emitter `conversation`, the consumer `conversation`, `transient: true`, and `reconciling: true`. The display recorder does not store a transient part. The stored marker carries the divider (see the harness-thread-history capability).

The loop MUST log each compaction through its `Logger`: at `info` for a summary, and at `error` for an exchange with no summary. The record carries the id, the trigger, `tokensBefore`, and the duration. A record for a refusal also carries the HTTP status and the error text of the provider.

#### Scenario: A summary emits running and then done

- **GIVEN** a run that compacts one time with a summary
- **WHEN** the run returns
- **THEN** the `emit` got one `data-compaction` part with `running` and `tokensBefore`, and then one with `done` and `durationMs`, under the same id
- **AND** no part carries `tokensAfter`

#### Scenario: An exchange with no summary emits failed

- **GIVEN** a run whose exchange gives no summary
- **WHEN** the exchange ends
- **THEN** the terminal part carries `failed` and `durationMs`, and no `tokensAfter`

#### Scenario: An abort emits failed

- **GIVEN** a run whose signal aborts during the exchange
- **WHEN** the run returns
- **THEN** the terminal part carries `failed`, and the transcript holds no new marker

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

## ADDED Requirements

### Requirement: The loop compacts before the input of a turn joins the conversation

`RunAgentOptions` MUST accept an optional `turnInput`: the messages that open the turn of a chat thread, the user message and its context records. Without `turnInput`, the initial messages hold the whole conversation, and no turn-start compaction runs.

With `turnInput`, before the first request, the loop MUST compare the latest figure of the initial messages with the turn-start budget of the policy. When the figure exceeds that budget, the loop MUST do a turn-start compaction. Its exchange continues the view of the initial messages, thus it reads the prefix of the previous turn from the cache. Then the loop MUST append the input. With no policy, no turn-start budget, no figure, or a figure within the budget, the loop appends the input with no compaction.

After a turn-start summary, the loop MUST append the input with no context record. The records after the marker restate the current context, thus a record of the input only repeats one. When the turn-start exchange gives no summary, the input keeps its context records.

The loop MUST give the round sink the input as one round, directly before the first request. Thus the store holds each message in the order that the loop sent it: the history, the exchange, the marker and its records, and then the input.

When an abort ends the turn-start compaction, the run MUST end with the finish reason `aborted`, and the loop appends no input.

#### Scenario: A turn-start compaction runs before the input

- **GIVEN** a policy with a turn-start budget of 150,000 and a budget of 200,000, and initial messages whose last reply carries 160,000 input tokens
- **WHEN** the run starts with a `turnInput`
- **THEN** a turn-start compaction runs before the loop appends the input
- **AND** the first request of the task holds the summary marker, the records, and then the user message

#### Scenario: A turn-start exchange extends the view before the input

- **GIVEN** a run that does a turn-start compaction
- **WHEN** the exchange sends its first request
- **THEN** its messages are each message of the view of the initial messages, byte-identical, and then the request of the policy

#### Scenario: A figure under the turn-start budget does not compact at the turn start

- **GIVEN** a policy with a turn-start budget of 150,000, and initial messages whose last reply carries 140,000 input tokens
- **WHEN** the run starts with a `turnInput`
- **THEN** no exchange runs, and the first request ends with the user message and its context records

#### Scenario: The input drops its records after a turn-start summary

- **GIVEN** a `turnInput` of a user message and a working-memory record, and a turn-start compaction with a summary
- **WHEN** the loop sends the first request of the task
- **THEN** the request holds the working-memory record after the marker, and it holds no record of the input

#### Scenario: The input keeps its records after a turn-start compaction with no summary

- **GIVEN** a `turnInput` of a user message and a working-memory record, and a turn-start exchange that gives no summary
- **WHEN** the loop sends the first request of the task
- **THEN** the request ends with the user message and the working-memory record of the input

#### Scenario: The round sink gets the sent order

- **GIVEN** a run with a round sink that does a turn-start compaction
- **WHEN** the run returns
- **THEN** the sink got the exchange, then the marker with its records, and then the user message, as three rounds in this order

#### Scenario: An abort during a turn-start compaction appends no input

- **GIVEN** a run whose signal aborts during the turn-start exchange
- **WHEN** the run returns
- **THEN** `finish.reason` is `"aborted"`, and the transcript holds no message of the input
