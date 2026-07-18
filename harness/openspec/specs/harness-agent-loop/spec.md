# harness-agent-loop Specification

## Purpose

Define the harness agent loop — `runAgent`, a pure-async function that drives
one agent to a terminal reply over AI SDK `ModelMessage`s. The loop owns the
four message-shape invariants (in AI SDK message terms), a deterministic
step-naming contract (consumed by DBOS replay caching and
workflow-transcript reconstruction), the tool-error boundary that turns
`err(ToolError)`, thrown, and Zod-invalid tool calls into model-visible error
tool results, the iteration-cap wrap-up that forces a text answer instead of
throwing, and sub-agent delegation via a child `Session`. Durability (`runStep`)
and the event sink (`emit`) are injected, so the same loop body serves the
in-process chat route and durable DBOS workflow steps.

`runAgent` returns `{ messages, finish }`, where `finish = { reason, cappedOut,
truncationRecoveries }`. The terminal signal is a first-class value so durable
callers record the real `finish_reason` instead of a hardcoded `"stop"`, see
that a run was capped by the runaway guard (`cappedOut`), and see how many
output-token truncations the loop recovered from.

**Output-token truncation is a recoverable soft-error, not a stop.** A model
that hits its output ceiling mid-tool-call (commonly while streaming a large
file body into a `write_file` arg) would, if treated as a clean stop, append a
truncated tool call that is never dispatched — silently losing the work. So the
loop never executes a truncated trailing tool call (its input may be valid JSON
yet half-complete): it refuses the call with a retryable model-visible error
tool result, still dispatches any earlier complete tool calls from the same
turn, steers a truncated prose turn with a corrective user message, and
continues. Recovery is bounded by `maxIterations`. The output-token cap itself
is owned per-model by the AI SDK provider runtime, which surfaces a single
truncation signal the loop branches on.

**Tool dispatch is partitioned by durability ownership.** Each tool declares an
execution mode (see the harness-tools spec). `step` tools are wrapped as
deterministic durable steps and may run concurrently where AI SDK allows
parallel tool calls. `workflow` tools (the sandbox mutate tools) run through
their workflow-backed execution path — never inside a DBOS step context, so
their internal `DBOS.recv` is legal. `inline` tools run only when pure with no
external side effects. Results are associated with the original tool-call ids,
so the tool-call↔tool-result correspondence holds regardless of execution
order.

A thin wrapper, `runToTerminal`, drives agents whose result is delivered
exclusively through a terminal tool (`submit_plan`, `submit_report`,
`submit_profile`, `submit_synthesis`, …): it runs the agent, then, if the
outcome cell is still empty and the run was not aborted, grants one focused
salvage continuation whose only tools are the terminal tools, opened by a
corrective nudge and namespaced (`salvage:…`) so a durable caller's cache keys
do not collide with the first run's.

**Prompt caching is a property of the run, not of the provider.** A loop re-sends
its whole prefix — tools, system, and the transcript so far — on every iteration,
so it breaks even on a cache by the second one. The policy therefore rides on
`RunAgentOptions` (see the harness-providers spec for the policy type itself),
which is exactly what keeps it off the one-shot LLM calls made elsewhere — those
would pay the cache-write premium for a cache nothing ever reads back.

## Requirements

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

### Requirement: A denied tool approval terminates the turn

When a tool's user-approval request (see the tool-approval spec) is rejected, the tool's `execute` throws, and the AI SDK loop integration SHALL map that rejection to a model-visible `execution-denied` tool result carrying the user's feedback, then SHALL hard-stop the turn: concurrently dispatched sibling tool calls from the same reply run to completion and their results are appended alongside the denial, but the loop SHALL make no subsequent model call — no further tool-calling iteration and no tool-less wrap-up. The denial tool result is the turn's final content. This is distinct from the recoverable error-tool-result path: an ordinary tool error is one the model reads and retries around, whereas a denial ends the turn so the agent cannot flail against the user's decision. An approval (`once`/`always`) SHALL NOT terminate the turn — the tool proceeds and the loop continues normally.

#### Scenario: A rejected approval hard-stops the turn

- **GIVEN** a turn in which a tool's approval request is answered `reject`
- **WHEN** the loop dispatches that tool call
- **THEN** the turn's results carry a model-visible `execution-denied` result with the feedback, and the loop makes no subsequent model call — no further tool-calling iteration and no wrap-up

#### Scenario: Concurrent siblings complete before the stop

- **GIVEN** a reply whose parallel tool calls include one denied approval and one ordinary tool
- **WHEN** the loop processes the turn
- **THEN** the ordinary tool's result is appended alongside the denial, and the loop then stops

#### Scenario: The denial is distinguished from a recoverable tool error

- **GIVEN** a turn with one denied approval and no other failing tool
- **WHEN** the loop processes the results
- **THEN** it terminates the turn rather than continuing as it would for an ordinary retryable tool error

#### Scenario: An approved request does not terminate the turn

- **GIVEN** a turn in which a tool's approval request is answered `once`
- **WHEN** the loop dispatches that tool call
- **THEN** the tool proceeds to its guarded action and the loop continues normally

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

### Requirement: The loop caches its prompt prefix by default

`RunAgentOptions` SHALL accept an optional `promptCache: PromptCachePolicy`, defaulting to `DEFAULT_PROMPT_CACHE` (`{ ttl: "5m" }`) when the caller supplies none; a host whose endpoint ignores or charges badly for cache directives SHALL be able to pass `"off"`. The policy SHALL be translated to provider options ONCE per run, not per iteration, and the same options object SHALL be sent on every call — an identical request head is itself part of the cache contract, since the prefix must be byte-identical to be read back.

#### Scenario: A run with no policy still caches

- **WHEN** `runAgent` is invoked with no `promptCache`
- **THEN** every LLM call it makes SHALL carry the 5-minute cache directive

#### Scenario: A host opts out

- **WHEN** `runAgent` is invoked with `promptCache: "off"`
- **THEN** no LLM call it makes SHALL carry a cache directive

### Requirement: Cache token usage is recorded per run

`runAgent` SHALL accumulate the `ChatUsage` a provider reports across every LLM call the run makes — the forced wrap-up included — and record it on completion, keyed by `agent_id`, as counters for input tokens, output tokens, cache-read tokens, and cache-write tokens (alongside the iteration histogram and the cap-hit counter). Only what a provider actually reports SHALL be recorded: a provider that reports no usage SHALL contribute nothing rather than zero.

These two cache counters are what make prompt caching observable at all. The hit rate for an agent type is `cache_read_tokens / input_tokens` (the harness's `inputTokens` being the total billed prefix, cache reads included), and a flat-zero read counter against a non-zero write counter is the runtime symptom of a defeated cache — either a shifting prefix or an endpoint that ignores cache directives outright.

#### Scenario: A cached run records reads and writes separately

- **GIVEN** a multi-iteration run whose provider reports cache creation on the first call and cache reads on the rest
- **WHEN** the run completes
- **THEN** both the cache-read and cache-write counters SHALL be recorded for that `agent_id`

#### Scenario: A provider reporting no usage records no tokens

- **GIVEN** a provider that reports no `usage`
- **WHEN** the run completes
- **THEN** no token counter SHALL be incremented for it — not even with zero
