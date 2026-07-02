## MODIFIED Requirements

### Requirement: The loop preserves the four message-shape invariants

The AI SDK-backed `runAgent` integration SHALL preserve the loop invariants in AI SDK message terms: (1) assistant provider metadata required for continuation is preserved; (2) every assistant tool call produces a corresponding tool result message/part accepted by AI SDK; (3) parallel tool calls are dispatched according to tool execution mode and their results are assembled against the original tool-call ids; (4) the transcript is append-only and prior messages are never mutated.

#### Scenario: Signed provider metadata round-trips

- **GIVEN** an AI SDK provider reply containing signed provider metadata required for continuation
- **WHEN** the loop appends the reply
- **THEN** the stored assistant message retains that provider metadata

#### Scenario: Tool results correspond to tool calls

- **GIVEN** an assistant reply with three tool calls
- **WHEN** the loop dispatches them
- **THEN** each tool call has a corresponding AI SDK tool result associated with the same tool-call id

#### Scenario: Parallel tool results preserve tool-call association

- **GIVEN** an assistant reply with tool calls ordered `[A, B, C]`
- **WHEN** step-backed tools resolve in the order `C, A, B`
- **THEN** the loop returns results associated with tool-call ids `[A, B, C]`

### Requirement: Step names are deterministic and follow the documented scheme

The AI SDK loop integration SHALL name each model-call step deterministically and each step-backed tool execution deterministically. Default names SHALL remain stable for DBOS replay and workflow-transcript reconstruction; workflow call sites MAY provide an attempt-aware formatter that preserves the same semantic slots while adding the attempt suffix.

#### Scenario: Two runs over identical inputs produce identical step names

- **GIVEN** a fixed sequence of AI SDK model replies and tool results
- **WHEN** `runAgent` is run twice
- **THEN** both runs emit the identical ordered sequence of model and tool step names

### Requirement: The loop wraps tool failures as error tool results

When a tool execution returns `err(ToolError)`, throws, or receives invalid input, the AI SDK tool wrapper SHALL return an error tool result that the model can read and recover from. A fatal loop error matched by the injected fatal predicate, including cancellation from a workflow-backed tool, SHALL propagate out of the loop rather than becoming a model-visible tool result.

#### Scenario: A throwing tool becomes an error tool result

- **GIVEN** a tool whose execution throws
- **WHEN** the AI SDK loop dispatches it
- **THEN** the corresponding tool result is marked as an error and the loop can continue

#### Scenario: A fatal loop error is re-raised, not swallowed

- **GIVEN** a workflow-backed tool whose execution throws an error matched by `isFatalLoopError`
- **WHEN** the loop dispatches it
- **THEN** the error propagates out of the loop instead of becoming a model-visible tool result

#### Scenario: Invalid tool input is rejected before execute runs

- **GIVEN** a tool call whose input fails the tool's Zod schema
- **WHEN** the tool wrapper validates it
- **THEN** the tool implementation is never called and the model receives an error tool result

### Requirement: runAgent returns the message array plus a terminal finish signal

`runAgent` SHALL resolve to `{ messages, finish }`. `messages` SHALL be the append-only AI SDK `ModelMessage` transcript. `finish` SHALL expose the terminal reason, whether the loop hit the iteration cap, and how many output-token truncations were recovered.

#### Scenario: A clean stop reports the real stop reason

- **GIVEN** an AI SDK model whose final reply terminates cleanly
- **WHEN** `runAgent` returns
- **THEN** `finish.reason` records the model's terminal reason and `finish.cappedOut` is false

### Requirement: The loop forces a wrap-up at the iteration cap

When the loop reaches `maxIterations`, it SHALL force one final tool-less model call or AI SDK-equivalent finalization pass, append the response, and return `{ messages, finish }` with `finish.reason = "max_iterations"` and `finish.cappedOut = true`. It SHALL NOT throw solely because the iteration cap was reached.

#### Scenario: A non-terminating loop wraps up instead of throwing

- **GIVEN** a provider that always returns tool calls
- **WHEN** the loop reaches `maxIterations`
- **THEN** it makes one tool-less finalization call, appends the text reply, and returns `{ messages, finish }` with `finish.reason = "max_iterations"` and `finish.cappedOut = true`

### Requirement: max_tokens is a recoverable soft-error

On an output-token truncation signal from the AI SDK provider runtime, the loop SHALL NOT execute an incomplete trailing tool call. It SHALL provide a retryable model-visible error for that call where a tool call id exists, still dispatch any earlier complete tool calls from the same turn, and continue. A truncated prose reply SHALL be steered with a corrective user message and continued. Each recovery SHALL increment `finish.truncationRecoveries`, and recovery SHALL be bounded by `maxIterations`.

#### Scenario: A truncated trailing tool call is refused, not executed

- **GIVEN** a model reply that terminates due to output-token truncation while ending in a tool call
- **WHEN** the loop processes it
- **THEN** that tool implementation is never called, the model receives a retryable error result, the loop continues, and `finish.truncationRecoveries` is incremented

#### Scenario: Earlier complete tool calls in a truncated turn still run

- **GIVEN** a truncated reply with complete tool call `A` and incomplete trailing tool call `B`
- **WHEN** the loop processes it
- **THEN** `A` is dispatched normally and `B` is refused

#### Scenario: A truncated prose turn is steered and continued

- **GIVEN** a truncated reply containing no tool call
- **WHEN** the loop processes it
- **THEN** it appends a corrective user message and continues rather than returning

### Requirement: Tool dispatch is partitioned by durability ownership

Within one turn the AI SDK loop integration SHALL dispatch tool calls according to each tool's execution mode. `step` tools SHALL be wrapped as deterministic durable steps and MAY run concurrently where AI SDK allows parallel tool calls. `workflow` tools SHALL enter their workflow-backed execution path and SHALL NOT run inside a DBOS step context. `inline` tools SHALL run only when they are pure and have no external side effects. Results SHALL be associated with the original tool-call ids.

#### Scenario: Workflow-backed tools avoid DBOS step context

- **GIVEN** a turn whose tool calls include a workflow-backed sandbox mutate tool
- **WHEN** the loop dispatches it
- **THEN** the tool runs through its workflow-backed execution path rather than inside a `DBOS.runStep`

#### Scenario: Step-backed tools cache through deterministic steps

- **GIVEN** a turn whose tool calls include external lookup tools
- **WHEN** the loop dispatches them
- **THEN** each lookup runs through a deterministic `runStep` wrapper and can cache-hit on DBOS replay
