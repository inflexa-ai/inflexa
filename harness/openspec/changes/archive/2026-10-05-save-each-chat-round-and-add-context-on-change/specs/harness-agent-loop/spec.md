## MODIFIED Requirements

### Requirement: runAgent returns the message array plus a terminal finish signal

`runAgent` MUST resolve to `{ messages, finish }`. `messages` MUST be the append-only AI SDK `ModelMessage` transcript. `finish` MUST give the terminal reason, whether the loop hit the iteration cap, and the count of the output-token truncations that the loop recovered.

A reply whose finish reason is `"aborted"` MUST end the run through the same terminal return. `finish.reason` reports `"aborted"`. The partial assistant message joins `messages` only when it carries content, thus an empty partial adds no message.

When the partial joins `messages`, the loop MUST stamp the interruption marker on it (see the ai-sdk-message-storage capability). The loop MUST NOT stamp a message of an earlier round. A round sink can hold that round already, and the harness never changes a message that it gave away. The outcome of the chat turn records each abort (see the chat-turn capability).

An abort that lands during tool dispatch on a loop with no fatal-error predicate surfaces the same way. The error results of the aborted tools complete the `tool` message, and the next model call resolves `"aborted"`. The transcript MUST never end on a tool call without its result.

#### Scenario: A clean stop reports the real stop reason

- **GIVEN** an AI SDK model whose final reply stops cleanly
- **WHEN** `runAgent` returns
- **THEN** `finish.reason` records the terminal reason of the model, and `finish.cappedOut` is false

#### Scenario: An aborted stream returns the partial reply

- **GIVEN** a streaming chat that resolves `"aborted"` with partial text after the user interrupts
- **WHEN** `runAgent` returns
- **THEN** `finish.reason` is `"aborted"`, the transcript ends with the partial assistant message, and that message carries the interruption marker

#### Scenario: A no-output abort returns the transcript unchanged

- **GIVEN** an abort that fires before the model gave a delta
- **WHEN** `runAgent` returns
- **THEN** `finish.reason` is `"aborted"`, `messages` holds only the messages of the run before that request, and no message carries a new marker

#### Scenario: An abort during tool execution keeps the transcript valid

- **GIVEN** a turn whose tool call runs when the abort fires, on the chat path with no fatal-error predicate
- **WHEN** `runAgent` returns
- **THEN** the transcript ends `assistant(tool_use), tool(error results)`, `finish.reason` is `"aborted"`, and each tool call has its result
- **AND** no message of that round carries the marker, because the round sink got that round before the aborted request

## ADDED Requirements

### Requirement: The loop gives each completed round to an optional round sink

`RunAgentOptions` MUST accept an optional round sink, `onRound`. The loop MUST give the sink each message that it appends, one time, in the order of the transcript. A call of the sink gives one round: the messages that the loop appended after the last call.

The loop MUST call the sink at these points, when it appended at least one message after the last call:

- before each model request
- at each exit, after the not-run answers and after the interruption marker
- before it throws

The loop MUST await the sink before it continues. Thus a store behind the sink holds each message before a later request sends it. The loop MUST NOT change a message after it gives the message to the sink.

Before a throw, the loop MUST answer each unanswered tool call of the messages that the sink did not get, with the not-run result. Then it gives those messages to the sink, and it throws the first error again. When the sink itself rejects, the rejection passes through, and the loop does not call the sink again.

The loop MUST NOT read or write a store for the sink. A durable loop MUST pass no sink, because a replay runs the loop body again. A sink MUST NOT change the transcript: a run with a sink and a run without one return the same messages.

#### Scenario: The rounds and the result agree

- **GIVEN** a run of three requests with a sink
- **WHEN** the run returns
- **THEN** the initial messages and then each round, in order, equal the messages of the result

#### Scenario: The sink holds a round before the next request

- **GIVEN** a run whose model calls a tool in its first reply
- **WHEN** the loop sends the second request
- **THEN** the sink holds the first reply and its tool message already

#### Scenario: A throw during tool dispatch gives the open round

- **GIVEN** a run with a sink, whose tool throws an error that the fatal predicate matches
- **WHEN** the run throws
- **THEN** the last round holds the assistant message and a not-run result for each of its calls, and the run throws the same error

#### Scenario: A failed first request gives no round

- **GIVEN** a run whose first model request fails
- **WHEN** the run throws
- **THEN** the sink got no call

#### Scenario: The wrap-up request rides the round before it

- **GIVEN** a run with a sink that reaches its cap
- **WHEN** the loop sends the first wrap-up request
- **THEN** the sink holds the text of the wrap-up request already

#### Scenario: A sink does not change the transcript

- **GIVEN** two runs of one model script, one with a sink and one with no `onRound`
- **WHEN** both runs return
- **THEN** the two runs give the same messages and the same finish
