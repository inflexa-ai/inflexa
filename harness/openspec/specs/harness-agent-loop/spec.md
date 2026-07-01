# harness-agent-loop Specification

## Purpose

Define the harness agent loop — `runAgent`, a pure-async function that drives
one agent to a terminal reply. The loop owns the four Anthropic message-shape
invariants, a deterministic step-naming contract (consumed by DBOS replay
caching and workflow-transcript reconstruction), the tool-error boundary that
turns `err(ToolError)`, thrown, and Zod-invalid tool calls into `is_error` tool
results, the iteration-cap wrap-up that forces a text answer instead of
throwing, and sub-agent delegation via a child `Session`. Durability (`runStep`)
and the event sink (`emit`) are injected, so the same loop body serves the
in-process chat route and durable DBOS workflow steps.

`runAgent` returns `{ messages, finish }`, where `finish = { reason, cappedOut,
truncationRecoveries }`. The terminal signal is a first-class value so durable
callers record the real `finish_reason` instead of a hardcoded `"stop"`, see
that a run was capped by the runaway guard (`cappedOut`), and see how many
output-token truncations the loop recovered from.

**`max_tokens` is a recoverable soft-error, not a stop.** A model that hits its
output ceiling mid-tool-call (commonly while streaming a large file body into a
`write_file` arg) would, if treated as a clean stop, append a truncated
`tool_use` that is never dispatched — silently losing the work. So the loop
never executes a truncated trailing `tool_use` (its input may be valid JSON yet
half-complete): it refuses the call with a retryable `is_error` `tool_result`,
still dispatches any earlier complete tool calls from the same turn, steers a
truncated prose turn with a corrective `user` message, and continues. Recovery
is bounded by `maxIterations`. The output-token cap itself is owned per-model by
the provider (see the harness-providers spec), and every provider normalizes its
truncation signal into the single Anthropic `stop_reason: "max_tokens"` the loop
branches on.

**Tool dispatch is partitioned by durability ownership.** Tools wrapped in the
loop's default `runStep` are dispatched concurrently — each reserves exactly one
function-id synchronously in array order, keeping the bio-lookup fan-out
parallel and replay-deterministic. Tools that opt out via `bodyContext: true`
(the sandbox mutate tools, which run unwrapped in the workflow body so their
internal `DBOS.recv` is legal) are dispatched sequentially after the wrapped
batch, because they reserve multiple function-ids across awaits and concurrent
ones would race the replay counter. Results are reassembled by original index,
so the tool_use↔tool_result ordering invariant holds regardless of execution
order.

A thin wrapper, `runToTerminal`, drives agents whose result is delivered
exclusively through a terminal tool (`submit_plan`, `submit_report`,
`submit_profile`, `submit_synthesis`, …): it runs the agent, then, if the
outcome cell is still empty and the run was not aborted, grants one focused
salvage continuation whose only tools are the terminal tools, opened by a
corrective nudge and namespaced (`salvage:…`) so a durable caller's cache keys
do not collide with the first run's.

## Requirements

### Requirement: The loop preserves the four message-shape invariants

`runAgent` SHALL guarantee, on every iteration: (1) assistant content blocks — including signed `thinking` blocks — are appended verbatim; (2) all `tool_use` blocks from one assistant message produce `tool_result` blocks in exactly one following `user` message with no interleaved text; (3) parallel `tool_use` blocks are dispatched and their results assembled in array order; (4) the messages array is append-only — prior messages are never mutated.

#### Scenario: A signed thinking block round-trips

- **GIVEN** a provider reply containing a `thinking` block with a signature
- **WHEN** the loop appends the reply
- **THEN** the assistant message in the array carries the identical `signature`

#### Scenario: Tool results follow tool uses in one user message

- **GIVEN** an assistant reply with three `tool_use` blocks
- **WHEN** the loop dispatches them
- **THEN** exactly one following `user` message carries three `tool_result` blocks, with no interleaved user text

#### Scenario: Parallel tool results preserve array order

- **GIVEN** an assistant reply with `tool_use` blocks ordered `[A, B, C]`
- **WHEN** the tools resolve in the order `C, A, B`
- **THEN** the `tool_result` blocks are assembled in the order `[A, B, C]`

### Requirement: Step names are deterministic and follow the documented scheme

The loop SHALL name each LLM step `llm-${i}` and each tool step `tool-${name}-${toolUseId}`. Step naming SHALL be deterministic given identical inputs. This scheme is a contract consumed by DBOS replay caching (PR #3) and workflow-transcript reconstruction.

#### Scenario: Two runs over identical inputs produce identical step names

- **GIVEN** a fixed sequence of provider replies and tool results
- **WHEN** `runAgent` is run twice
- **THEN** both runs emit the identical ordered sequence of step names

### Requirement: The loop wraps tool failures as error tool results

When a tool's `execute` returns `err(ToolError)` or throws, the loop SHALL catch it at the dispatch boundary and produce `tool_result { is_error: true, content: { error, retryable } }` — a `ToolError` is used verbatim, any other throwable is classified by origin. When tool input fails Zod validation, the loop SHALL produce `tool_result { is_error: true }` before calling `execute`. A tool failure SHALL NOT abort the loop, except for an error the injected `isFatalLoopError` predicate marks fatal (e.g. a `bodyContext` tool's workflow-cancellation throw), which is re-raised.

#### Scenario: A throwing tool becomes an error tool result

- **GIVEN** a tool whose `execute` throws
- **WHEN** the loop dispatches it
- **THEN** the corresponding `tool_result` has `is_error: true` and the loop continues

#### Scenario: A fatal loop error is re-raised, not swallowed

- **GIVEN** a `bodyContext` tool whose `execute` throws an error matched by `isFatalLoopError`
- **WHEN** the loop dispatches it
- **THEN** the error propagates out of the loop instead of becoming an `is_error` tool result

#### Scenario: Invalid tool input is rejected before execute runs

- **GIVEN** a `tool_use` whose input fails the tool's Zod schema
- **WHEN** the loop dispatches it
- **THEN** `execute` is never called and the `tool_result` has `is_error: true`

### Requirement: runAgent returns the message array plus a terminal finish signal

`runAgent` SHALL resolve to `{ messages, finish }`. `messages` is the append-only array (initial messages plus every appended assistant reply and tool-result message). `finish` SHALL be `{ reason, cappedOut, truncationRecoveries }`: `reason` is the real terminal `stop_reason` on a clean stop or `"max_iterations"` when the runaway guard fired; `cappedOut` is true only on that wrap-up path; `truncationRecoveries` counts the `max_tokens` soft-errors the loop recovered from.

#### Scenario: A clean stop reports the real stop reason

- **GIVEN** a provider whose final reply has `stop_reason: "end_turn"`
- **WHEN** `runAgent` returns
- **THEN** `finish.reason` is `"end_turn"`, `finish.cappedOut` is false

### Requirement: The loop forces a wrap-up at the iteration cap

When the loop reaches `maxIterations`, it SHALL make one final provider call with `tools: []`, forcing a text reply, and return `{ messages, finish }` with `finish.reason = "max_iterations"` and `finish.cappedOut = true` — it SHALL NOT throw.

#### Scenario: A non-terminating loop wraps up instead of throwing

- **GIVEN** a provider that always returns `stop_reason: "tool_use"`
- **WHEN** the loop reaches `maxIterations`
- **THEN** it makes one tool-less call, appends the text reply, and returns `{ messages, finish }` with `finish.reason = "max_iterations"` and `finish.cappedOut = true`, without throwing

### Requirement: max_tokens is a recoverable soft-error

On a reply with `stop_reason: "max_tokens"` the loop SHALL NOT execute the truncated trailing `tool_use`; it SHALL synthesize a retryable `is_error` `tool_result` for that call (generic wording, naming no tool), still dispatch any earlier complete `tool_use` blocks from the same turn, and continue. A truncated reply carrying no `tool_use` SHALL be steered with a corrective `user` message and continued. Each recovery SHALL increment `finish.truncationRecoveries`, and recovery SHALL be bounded by `maxIterations`.

#### Scenario: A truncated trailing tool call is refused, not executed

- **GIVEN** an assistant reply with `stop_reason: "max_tokens"` ending in a `tool_use`
- **WHEN** the loop processes it
- **THEN** that tool's `execute` is never called, its `tool_result` is `is_error: true`, the loop continues, and `finish.truncationRecoveries` is incremented

#### Scenario: Earlier complete tool calls in a truncated turn still run

- **GIVEN** a `max_tokens` reply with `tool_use` blocks `[A, B]` where `B` is the truncated trailing call
- **WHEN** the loop processes it
- **THEN** `A` is dispatched normally and `B` is refused, with both `tool_result`s assembled in order `[A, B]`

#### Scenario: A truncated prose turn is steered and continued

- **GIVEN** a `max_tokens` reply containing no `tool_use`
- **WHEN** the loop processes it
- **THEN** it appends a corrective `user` message and continues rather than returning

### Requirement: Tool dispatch is partitioned by durability ownership

Within one turn the loop SHALL dispatch tools wrapped in `runStep` concurrently, reserving each one's step synchronously in array order, and SHALL dispatch `bodyContext` tools sequentially after the wrapped batch. Results SHALL be assembled by the tool call's original index regardless of execution order.

#### Scenario: bodyContext tools run after the concurrent wrapped batch

- **GIVEN** a turn whose `tool_use` blocks mix wrapped tools and a `bodyContext` tool
- **WHEN** the loop dispatches them
- **THEN** the wrapped tools run concurrently, the `bodyContext` tool runs sequentially afterward, and every `tool_result` lands at its original index

### Requirement: runToTerminal salvages a run that never reached its terminal tool

`runToTerminal` SHALL run the agent and, when the terminal-outcome cell is unresolved and the run was not aborted, grant exactly one salvage continuation whose tool surface is only the terminal tools, opened by a corrective nudge and with salvage step names namespaced so a durable caller does not reuse the first run's cache slots. When the run already resolved (or was aborted), it SHALL return the first run's result unchanged.

#### Scenario: An agent that never submits gets one terminal-only salvage turn

- **GIVEN** an agent that exhausts its budget without calling its terminal tool
- **WHEN** `runToTerminal` runs it
- **THEN** one salvage continuation runs with only the terminal tools offered and a corrective nudge prepended

#### Scenario: A resolved run is returned without salvage

- **GIVEN** an agent that calls its terminal tool during the first run
- **WHEN** `runToTerminal` runs it
- **THEN** no salvage continuation is started and the first run's result is returned

### Requirement: Sub-agent delegation derives a child Session

A sub-agent tool SHALL invoke `runAgent` with a child `Session` derived via `forSubAgent` — `agentId` set to the sub-agent and `callPath` extended — leaving the parent `Session` unmutated. The sub-agent's messages SHALL NOT be persisted.

#### Scenario: The literature-reviewer tool runs with a derived Session

- **GIVEN** the conversation loop dispatches the `literatureReviewer` tool
- **WHEN** the tool invokes `runAgent`
- **THEN** the child `Session` has `callPath` extended with `"literature-reviewer"`, the parent `Session` is unchanged, and the child transcript is not written to any message store
