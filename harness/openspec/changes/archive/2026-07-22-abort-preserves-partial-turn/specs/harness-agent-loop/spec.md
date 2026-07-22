## MODIFIED Requirements

### Requirement: runAgent returns the message array plus a terminal finish signal

`runAgent` SHALL resolve to `{ messages, finish }`. `messages` SHALL be the append-only AI SDK `ModelMessage` transcript. `finish` SHALL expose the terminal reason, whether the loop hit the iteration cap, and how many output-token truncations were recovered. A reply whose finish reason is `"aborted"` SHALL end the run through the same terminal return: `finish.reason` reports `"aborted"`, the partial assistant message joins `messages` only when it carries content (an empty partial contributes no message), and the loop SHALL stamp the interruption marker (see the ai-sdk-message-storage capability) on the last loop-produced assistant message when one exists. An abort that lands during tool dispatch on a loop with no fatal-error predicate SHALL surface the same way: the aborted tools' error results complete the `tool` message, and the following model call resolves `"aborted"` — the transcript SHALL never end on a tool call without its result.

#### Scenario: A clean stop reports the real stop reason

- **GIVEN** an AI SDK model whose final reply terminates cleanly
- **WHEN** `runAgent` returns
- **THEN** `finish.reason` records the model's terminal reason and `finish.cappedOut` is false

#### Scenario: An aborted stream returns the partial reply

- **GIVEN** a streaming chat that resolves `"aborted"` with partial text after the user interrupts
- **WHEN** `runAgent` returns
- **THEN** `finish.reason` is `"aborted"`, the transcript ends with the partial assistant message, and that message carries the interruption marker

#### Scenario: A no-output abort returns the transcript unchanged

- **GIVEN** an abort that fires before the model produced any delta
- **WHEN** `runAgent` returns
- **THEN** `finish.reason` is `"aborted"` and `messages` contains nothing beyond the initial messages — no empty assistant message is appended

#### Scenario: An abort during tool execution keeps the transcript valid

- **GIVEN** a turn whose tool call is executing when the abort fires (chat path — no fatal-error predicate)
- **WHEN** `runAgent` returns
- **THEN** the transcript ends `assistant(tool_use), tool(error results)` with the marker on the tool-calling assistant message, `finish.reason` is `"aborted"`, and no tool call lacks a result
