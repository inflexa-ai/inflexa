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

**Tool dispatch obeys the execution mode of each tool** (see the harness-tools
spec). The loop wraps each `step` tool call as a deterministic durable step, and
the step calls of one round can run at the same time. A sandbox tool is a
`step` tool, and its exec runs inside its tool step. `inline` tools run after
the step calls, one at a time, with no step. After the round, the loop folds the
call record of each call in call order, thus a replay folds the same records.
The loop associates each result with the original tool-call id, thus the
tool-call to tool-result correspondence holds in each execution order.

A thin wrapper, `runToTerminal`, drives agents whose result is delivered
exclusively through a terminal tool (`submit_plan`,
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

When a tool execution returns `err(ToolError)`, throws, or receives invalid
input, the AI SDK tool wrapper MUST return an error tool result. The model can
read that result and recover from it. A fatal loop error that the injected fatal
predicate matches MUST propagate out of the loop, and it MUST NOT become a
model-visible tool result. The cancel of a sandbox exec inside a step tool is
one example.

#### Scenario: A throwing tool becomes an error tool result

- **GIVEN** a tool whose execution throws
- **WHEN** the AI SDK loop dispatches it
- **THEN** the corresponding tool result is marked as an error and the loop can continue

#### Scenario: A fatal loop error is re-raised, not swallowed

- **GIVEN** a step tool whose execution throws an error that `isFatalLoopError` matches, for example the `DBOSWorkflowCancelledError` of a canceled sandbox exec
- **WHEN** the loop dispatches it
- **THEN** the error propagates out of the loop instead of becoming a model-visible tool result

#### Scenario: Invalid tool input is rejected before execute runs

- **GIVEN** a tool call whose input fails the tool's Zod schema
- **WHEN** the tool wrapper validates it
- **THEN** the tool implementation is never called and the model receives an error tool result

### Requirement: A denied tool approval terminates the turn

When the user rejects the approval request of a tool (refer to the tool-approval capability), the `execute` of the tool throws. The loop MUST change that rejection into a model-visible `execution-denied` tool result that carries the feedback of the user. Then the loop MUST stop the turn.

The sibling tool calls of the same reply complete, and the loop appends their results beside the denial. The loop MUST NOT make a model call after the denial: no tool-calling iteration and no wrap-up request. The denial tool result is the final content of the turn.

A denial is different from a recoverable tool error. The model reads an ordinary tool error and tries again. A denial ends the turn, thus the agent cannot argue with the decision of the user. An approval (`once` or `always`) MUST NOT end the turn. The tool continues to its guarded action, and the loop continues as usual.

#### Scenario: A rejected approval hard-stops the turn

- **GIVEN** a turn in which the answer to the approval request of a tool is `reject`
- **WHEN** the loop dispatches that tool call
- **THEN** the results of the turn carry a model-visible `execution-denied` result with the feedback
- **AND** the loop makes no model call after it: no tool-calling iteration and no wrap-up request

#### Scenario: Concurrent siblings complete before the stop

- **GIVEN** a reply whose parallel tool calls include one denied approval and one ordinary tool
- **WHEN** the loop processes the turn
- **THEN** the loop appends the result of the ordinary tool beside the denial, and then the loop stops

#### Scenario: The denial is distinguished from a recoverable tool error

- **GIVEN** a turn with one denied approval and no other tool that fails
- **WHEN** the loop processes the results
- **THEN** it ends the turn, and it does not continue as it does for an ordinary retryable tool error

#### Scenario: An approved request does not terminate the turn

- **GIVEN** a turn in which the answer to the approval request of a tool is `once`
- **WHEN** the loop dispatches that tool call
- **THEN** the tool continues to its guarded action, and the loop continues as usual

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

### Requirement: The loop forces a wrap-up at the iteration cap

When the loop reaches `maxIterations`, it MUST run a wrap-up continuation, and it MUST NOT throw because of the cap. The wrap-up MUST append one harness request that tells the model to answer in text. The wrap-up MUST use the mask `"none"` and a cap of 2 requests.

Each wrap-up request MUST send the declared tools and the `toolChoice` of the run with no change. The loop MUST NOT send `toolChoice: "none"`, because `@ai-sdk/anthropic` removes the tools from a request with that value. Anthropic also drops its message cache when `tool_choice` changes.

A tool call in a wrap-up reply MUST get the error result of the mask, and its tool MUST NOT run. After a refusal, the next wrap-up request follows. After 2 requests, the wrap-up ends, also when the last reply called a tool.

The wrap-up MUST name its request `k` (zero-based) `formatStepName.llm(maxIterations + k)`. Thus the first request keeps the step name of the earlier single wrap-up call. The run MUST return `{ messages, finish }` with `finish.reason = "max_iterations"` and `finish.cappedOut = true`. An abort during the wrap-up gives `finish.reason = "aborted"`, and `finish.cappedOut` stays `true`.

#### Scenario: A non-terminating loop wraps up instead of throwing

- **GIVEN** a provider that always returns tool calls
- **WHEN** the loop reaches `maxIterations`
- **THEN** it runs the wrap-up, no tool runs in the wrap-up, and it returns `{ messages, finish }` with `finish.reason = "max_iterations"` and `finish.cappedOut = true`

#### Scenario: The wrap-up keeps the declared tools and the tool choice

- **GIVEN** a run that reaches its cap
- **WHEN** the loop sends each wrap-up request
- **THEN** the request carries the same `tools` and the same `toolChoice` as each loop request, and it carries no `toolChoice: "none"`

#### Scenario: A text reply ends the wrap-up

- **GIVEN** a model that answers the first wrap-up request in text
- **WHEN** the wrap-up runs
- **THEN** the loop sends one wrap-up request under the step name `formatStepName.llm(maxIterations)`, and the transcript ends with that text

#### Scenario: A refused call gets a second request

- **GIVEN** a model that calls a tool in the first wrap-up reply and answers in text in the second reply
- **WHEN** the wrap-up runs
- **THEN** the tool does not run, and the call gets the error result of the mask
- **AND** the transcript ends with the text of the second reply

#### Scenario: The wrap-up is bounded

- **GIVEN** a model that calls a tool in each wrap-up reply
- **WHEN** the wrap-up runs
- **THEN** the loop sends exactly 2 wrap-up requests, the transcript ends with the error results of the second reply, and `finish.reason` is `"max_iterations"`

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

### Requirement: The tool-finished observation reports the call's own elapsed time

The loop's `tool-finished` event MUST carry `durationMs`, the time elapsed around
that call's own dispatch. The loop MUST measure each call individually, around
the same unit it awaits for that call: the durable step wrapper for a step-mode
tool, and the dispatch itself for an inline-mode tool.

The field MUST be OPTIONAL, and it MUST be absent rather than zero when no
measurement was taken. A host MUST be free to use its own measurement when the
field is absent, thus a consumer built against an earlier harness keeps working.

The loop emits each `tool-started` for a round before it dispatches anything and
each `tool-finished` after the round settles. That order is deliberate: it lets a
host show the whole round's calls at once, which is an honest preview of what the
model asked for. But a host that measures between the two events measures the
round and not the call. Each call in a round then reports the same figure. When
each call has its own description, that figure is a false claim about each one.

The measure inside the loop makes the order and the timing both correct. The
alternative is to emit the events of each call around its own dispatch. Then
the chips of the round would appear one at a time for the inline mode.

Both dispatch paths MUST report timing through the same path, thus a truncated
round and a normal one cannot disagree.

#### Scenario: Concurrent calls in one round report their own durations

- **GIVEN** a dispatch round of some step-mode tool calls, one of which takes substantially longer than the others
- **WHEN** the loop emits their finished events
- **THEN** each event carries that call's own elapsed time, and the faster calls do not report the slower call's figure

#### Scenario: A sequentially dispatched call is not charged for its predecessors

- **GIVEN** a dispatch round of some inline-mode tool calls, which dispatch one after another
- **WHEN** the loop emits their finished events
- **THEN** each event reports only the time around its own dispatch, not the elapsed time since the round began

#### Scenario: A failed call still reports its duration

- **GIVEN** a tool whose execution throws a non-fatal error
- **WHEN** the loop emits that call's finished event
- **THEN** the event reports `outcome: "error"` and carries the elapsed time around the failed dispatch

#### Scenario: A host without the field falls back to its own measurement

- **GIVEN** a `tool-finished` event carrying no `durationMs`
- **WHEN** a host renders that call
- **THEN** it reports a duration derived from its own observation rather than none

### Requirement: runToTerminal salvages a run that never reached its terminal tool

`runToTerminal` MUST run the agent. When the terminal-outcome cell is not resolved and the run was not aborted, it MUST run exactly one salvage continuation. The salvage continuation MUST keep the declared tools of the agent, and its mask MUST let only the terminal tools run. Its request MUST be the corrective nudge. Its step names MUST carry the namespace `salvage`, thus a durable caller does not use the cache slots of the first run again. When the run resolved, or when it was aborted, `runToTerminal` MUST return the result of the first run with no change.

`runToTerminal` MUST throw when a terminal tool is not a declared tool of the agent, because a mask cannot let an undeclared tool run.

A salvage continuation that starts MUST be reported at `warn` through the `Logger` of the loop, because the agent ended without its terminal outcome. Only `runToTerminal` can report this. The loop sees the salvage as a continuation with a small cap and a mask. It cannot know that the salvage is a second attempt.

#### Scenario: An agent that never submits gets one terminal-only salvage turn

- **GIVEN** an agent that uses its full budget and does not call its terminal tool
- **WHEN** `runToTerminal` runs it
- **THEN** one salvage continuation runs, its request is the corrective nudge, and its mask lets only the terminal tools run

#### Scenario: The salvage keeps the declared tools

- **GIVEN** an agent with 4 declared tools, 2 of them terminal
- **WHEN** the salvage continuation sends a request
- **THEN** the request declares the same 4 tools as the requests of the first run
- **AND** a call to a tool that is not terminal gets an error result, and that tool does not run

#### Scenario: A resolved run is returned without salvage

- **GIVEN** an agent that calls its terminal tool during the first run
- **WHEN** `runToTerminal` runs it
- **THEN** no salvage continuation starts, and the result of the first run is returned

#### Scenario: A fired salvage is reported

- **GIVEN** an agent that uses its full budget and does not call its terminal tool
- **WHEN** `runToTerminal` starts the salvage continuation
- **THEN** a record at `warn` names the agent whose run did not resolve

#### Scenario: A resolved run reports no salvage

- **GIVEN** an agent that calls its terminal tool during the first run
- **WHEN** `runToTerminal` returns
- **THEN** no salvage record exists

### Requirement: Sub-agent delegation derives a child Session

A sub-agent tool SHALL invoke `runAgent` with a child `Session` derived via `forSubAgent` — `agentId` set to the sub-agent and `callPath` extended — leaving the parent `Session` unmutated. The sub-agent's messages SHALL NOT be persisted.

#### Scenario: The literature-reviewer tool runs with a derived Session

- **GIVEN** the conversation loop dispatches the `literatureReviewer` tool
- **WHEN** the tool invokes `runAgent`
- **THEN** the child `Session` has `callPath` extended with `"literature-reviewer"`, the parent `Session` is unchanged, and the child transcript is not written to any message store

### Requirement: The loop caches its prompt prefix by default

`RunAgentOptions` MUST accept an optional `promptCache: PromptCachePolicy`. It MUST default to `DEFAULT_PROMPT_CACHE` (`{ ttl: "5m" }`) when the caller supplies none. A host whose endpoint ignores cache directives, or charges badly for them, MUST be able to pass `"off"`.

The loop MUST resolve the policy ONCE per run. An identical policy across every call is part of the cache contract, because the prefix must be byte-identical to be read back.

The loop MUST place two breakpoints on each call, and MUST NOT attach a cache directive to the request itself:

- `withSystemPromptBreakpoint` marks the end of the system prompt. The system prompt of an agent depends only on its type, thus the loop can make the marked system prompt one time for each run.
- `withPromptCacheBreakpoint` marks the last message that can carry a directive. The transcript grows with each iteration, thus the loop places this breakpoint again on each call.

The placement of the message breakpoint MUST roll forward with the transcript. Each iteration appends the reply of the model and the results of its tools. The next call then reads back what the last call wrote. A breakpoint pinned before the tool messages makes each iteration send the whole tool transcript uncached.

The breakpoint at the end of the system prompt caches the tools and the system prompt as one entry. A new thread reads that entry back. The first call after a shift of the message prefix also reads it back.

Each wrap-up request MUST carry the same two breakpoints. It sends the tool set and the `toolChoice` of the loop with no change, and a mask refuses each tool call. Thus it keeps the prefix, and it reads the cached prefix back. Each request of a continuation obeys the same rule.

#### Scenario: A run with no policy still caches

- **WHEN** `runAgent` is invoked with no `promptCache`
- **THEN** every LLM call it makes MUST carry the 5-minute cache directive on its system prompt and on its last message

#### Scenario: No call carries a request-level directive

- **WHEN** `runAgent` makes any LLM call
- **THEN** no cache directive of the call MUST reach the wire as a top-level `cache_control` field, because an intermediary cannot count such a breakpoint

#### Scenario: The breakpoint rolls forward across iterations

- **GIVEN** a run whose model calls a tool on each iteration
- **WHEN** the loop makes each call
- **THEN** the marked message index MUST grow from one call to the next

#### Scenario: The system prompt keeps its breakpoint on each call

- **GIVEN** a run of three iterations that ends in the forced wrap-up
- **WHEN** the loop makes each call
- **THEN** the `system` of each request MUST be the same system message, with the cache directive of the policy

#### Scenario: The wrap-up reads the cached prefix

- **GIVEN** a run that reaches its cap
- **WHEN** the loop sends the first wrap-up request
- **THEN** the request carries the tools, the system prompt, and the two breakpoints of the loop requests, and it carries no `toolChoice: "none"`

#### Scenario: The transcript the run returns is unmarked

- **WHEN** `runAgent` completes
- **THEN** no message of `AgentRunResult.messages` MUST carry a cache directive, because a host writes that array to a thread store

#### Scenario: A host opts out

- **WHEN** `runAgent` is invoked with `promptCache: "off"`
- **THEN** no LLM call it makes MUST carry a cache directive, on the system prompt, on a message, or on the request

### Requirement: The loop reports its own lifecycle through an injected Logger

`runAgent` SHALL accept an optional `Logger` on its options and SHALL report its lifecycle through
it. The option SHALL be optional and SHALL resolve to `createNoopLogger()` when absent, so a caller
that wires nothing behaves exactly as it does with no logging at all, and SHALL be resolved once
per run rather than consulted conditionally at each call site.

Every record the loop writes SHALL carry the run's `agentId` and `callPath` as structured fields,
derived from the same `EventSource` value the loop builds for its emitted events, so a record and
an event can never disagree about which agent produced them. A sub-agent's records are therefore
attributable to the parent that spawned it, which is what makes them useful on a surface that
deliberately filters sub-agent *events* out by that same `callPath` depth.

The loop SHALL write exactly one terminal record per completed run, carrying the iteration count,
the finish reason, whether the run exhausted its iteration cap, and the token usage it accumulated.
It SHALL NOT write a terminal record per iteration.

#### Scenario: A completed run leaves one terminal record

- **GIVEN** an agent whose model replies without tool calls on its second iteration
- **WHEN** `runAgent` returns
- **THEN** exactly one terminal record is written, carrying the iteration count, the finish reason, `cappedOut`, and the accumulated token usage

#### Scenario: A record names the agent and its call path

- **GIVEN** a sub-agent invoked with a `callPath` extended from its parent
- **WHEN** the loop writes any record
- **THEN** that record carries `agentId` and `callPath` as structured fields rather than interpolated into the message

#### Scenario: A caller that wires no logger is unaffected

- **GIVEN** a `runAgent` call whose options omit the logger
- **WHEN** the run completes
- **THEN** no record is written anywhere and the returned result is identical to the same run with a logger wired

### Requirement: Loop log levels are assigned by outcome class, not by call site

The loop MUST assign the levels thus that the default level stays affordable for a long run. A degraded outcome MUST show at the default level:

- `debug`: one record for each iteration, which names the tools that the iteration dispatched.
- `info`: the terminal record of a run that ended as intended.
- `warn`: a run that gave a result but did not end as intended. The run used its iteration cap and ran the wrap-up, or it ended on a denied tool approval.
- `error`: a run that could not give a result.

The record of each iteration is the only record whose count grows with the length of the run. Thus at the default level, a run MUST give a bounded count of records, whatever the count of its iterations.

#### Scenario: A capped-out run is visible at the default level

- **GIVEN** an agent that uses all of its `maxIterations` and runs the wrap-up
- **WHEN** the run completes
- **THEN** its terminal record is at `warn`, not at `info`

#### Scenario: Per-iteration detail is confined to debug

- **GIVEN** an agent that runs for ten iterations
- **WHEN** the sink filters at `info`
- **THEN** one record of the run stays, and none of the ten records of the iterations stays

#### Scenario: A denied approval is a degraded outcome

- **GIVEN** a tool approval that the user denies, which ends the turn
- **WHEN** the loop returns
- **THEN** the terminal record is at `warn`, and it carries the denial as the finish reason

### Requirement: The loop places a tool picture by the capability precedence

The loop MUST place a tool picture by this precedence: the tool result, then a user message, then the drop. When `imageToolResults` is set, the picture MUST ride the tool result as an image block. When `imageToolResults` is absent and `imageUserMessages` is set, the tool result MUST keep its JSON text. The loop MUST then append one user message directly after the tool message of the round. That message MUST batch each dropped picture of the round.

For each picture, the message MUST carry a text part and then a file part. The text part MUST name the tool call. The file part MUST carry the media type and the bytes. When both flags are absent, the loop MUST drop the picture and record a warn. The transcript MUST stay append-only in every mode. The fallback message MUST carry the synthetic marker of the harness namespace, thus it opens no conversation turn.

A tool ok value MAY carry an ordered list of pictures, and the loop MUST keep the order of the list on the wire. The one-picture convention MUST read as a list of one, thus a tool that attaches one picture and a tool that attaches a list meet the loop in the same shape. The placement precedence above applies to the list, and no capability flag distinguishes the list: a wire that declares a picture capability declares it for the list.

When `imageToolResults` is set, the tool result MUST carry the JSON text part and then one image block per picture, in order. When `imageToolResults` is absent and `imageUserMessages` is set, the fallback user message MUST carry each picture of the result in order, each behind a text part that names the tool call; a result with several pictures MUST number them. When both flags are absent, the loop MUST drop every picture of the result, keep the JSON text, and record one warn that carries the count.

#### Scenario: The fallback carries the picture

- **GIVEN** a provider that advertises `imageUserMessages` and not `imageToolResults`
- **WHEN** a tool result of a round carries a picture
- **THEN** the round ends with one user message that holds the picture and names its tool call, and the tool result keeps its JSON text

#### Scenario: One message batches the pictures of a round

- **WHEN** two tool calls of one round each give a picture
- **THEN** one user message after the tool message carries both pictures, in the order of the tool calls

#### Scenario: The tool-result path stays exclusive

- **GIVEN** a provider that advertises both picture flags
- **WHEN** a tool result carries a picture
- **THEN** the picture rides the tool result only, and the loop appends no fallback message

#### Scenario: The fallback message opens no conversation turn

- **WHEN** the loop appends the fallback message
- **THEN** the message carries the synthetic marker, and a turn-boundary reader does not read it as a turn start

#### Scenario: A wire with neither flag drops the picture

- **GIVEN** a provider that advertises neither picture flag
- **WHEN** a tool result carries a picture
- **THEN** the loop drops the picture, keeps the JSON text, and records a warn

#### Scenario: A multi-picture result rides the tool result in order

- **GIVEN** a provider that advertises `imageToolResults`
- **WHEN** a tool result carries two pictures
- **THEN** the tool result carries the JSON text part and then the two image blocks, in the order the tool gave

#### Scenario: A multi-picture result rides the fallback message in order

- **GIVEN** a provider that advertises `imageUserMessages` and not `imageToolResults`
- **WHEN** a tool result carries two pictures
- **THEN** the fallback user message carries both pictures in order, each behind a numbered text part that names the tool call

#### Scenario: A wire with neither flag drops the list with one counted warn

- **GIVEN** a provider that advertises neither picture flag
- **WHEN** a tool result carries two pictures
- **THEN** the loop drops both, keeps the JSON text, and records one warn that carries the count of two

### Requirement: Token usage is recorded for each call

The loop MUST record the token counters of each LLM call when that call completes, the forced wrap-up included. It MUST NOT wait for the end of the run. Thus a run that throws keeps the count of the calls that completed before the throw.

The loop MUST grow the counters inside the step body of the call. A step that a recovery replays returns its stored reply and does not run its body. Thus the replay does not count the call again. A counter is cumulative, and no sink can remove a second count from it. The usage record keeps its idempotency key, thus the replay delivers the same record again, and an upserting sink counts it one time.

The loop MUST record these counters:

- `cortex.harness.agent.input_tokens`
- `cortex.harness.agent.output_tokens`
- `cortex.harness.agent.cache_read_tokens`
- `cortex.harness.agent.cache_write_tokens`
- `cortex.harness.agent.reasoning_tokens`

Each counter MUST carry these labels:

- `agent_id`: the id of the agent that makes the call. The loop uses the `id` of its `AgentDefinition`, or the accounting agent id of a continuation, the same as the iteration histogram. A direct call uses the id of its own agent. The label MUST NOT come from the provenance of the session. A host can give one root provenance to different agents, and their tokens would then merge.
- `model`: the `servedModelId` of the response. The label is absent when the response reports no served model.
- `provider`: the `provider` of the response. The label is absent when the response names no provider.

The loop MUST record only what a provider reports. A provider that reports no usage contributes nothing, not zero. The reasoning counter counts `ChatUsage.reasoningTokens`. Providers do not agree on whether reasoning tokens are inside `outputTokens`. The `provider` label keeps each series to one provider, thus one series sums figures of one meaning.

The iteration histogram and the cap-hit counter stay per run, with the `agent_id` label only. They describe a run, not a call.

The loop MUST also deliver each LLM call to the injected `UsageRecorder` as an attributed usage record when the call completes. It MUST surface its accumulated usage on its finish event. The root loop of a turn also surfaces the turn total, with the descendant loops. The llm-usage-accounting capability gives the details. The counters, the records, and the finish rollups are three surfaces over the same capture of each call. No surface replaces another, and the rule that absent means "not reported" holds on all three.

The ad hoc router calls `provider.chat` directly. It MUST grow the counters in the body that makes the call, under its own agent id. It MUST also use the same accounting path as the loop. Thus its call reaches the counters and the recorder.

The two cache counters make prompt caching observable. The hit rate of an agent type is `cache_read_tokens / input_tokens`, because `inputTokens` is the total billed prefix. A read counter at zero beside a write counter above zero shows a defeated cache. The cause is a prefix that shifts, or an endpoint that ignores cache directives.

The loop MUST deliver each record through the notice helper of the host-hooks capability. The loop MUST NOT wait for the result of `UsageRecorder.record`. When the result is an `err`, the loop MUST log the reason at the error level through its `Logger`. The `err` MUST NOT change the outcome of the run.

#### Scenario: A cached run records reads and writes separately

- **GIVEN** a run of some iterations whose provider reports a cache write on the first call and cache reads on the other calls
- **WHEN** the run completes
- **THEN** both the cache-read counter and the cache-write counter MUST hold the reported figures for that `agent_id`

#### Scenario: A provider reporting no usage records no tokens

- **GIVEN** a provider that reports no `usage`
- **WHEN** the run completes
- **THEN** no token counter MUST grow for it, not even by zero

#### Scenario: A run that throws keeps its completed calls

- **GIVEN** a run whose third LLM call fails fatally
- **WHEN** the run throws
- **THEN** the token counters MUST already hold the figures of the first two calls

#### Scenario: The counters carry the model and the provider

- **GIVEN** a response with the `servedModelId` `claude-opus-5-5` and the `provider` `anthropic.messages`
- **WHEN** the loop records the call
- **THEN** each token counter MUST carry `agent_id`, `model: "claude-opus-5-5"`, and `provider: "anthropic.messages"`

#### Scenario: Two agents of one root provenance stay apart

- **GIVEN** two loops of different agents, whose sessions carry the same provenance, for example `tui-chat`
- **WHEN** each loop records a call
- **THEN** the token counters MUST carry the id of the agent of each loop as `agent_id`, thus the two series stay apart

#### Scenario: A continuation counts under its accounting id

- **GIVEN** a continuation of a step agent with the accounting agent id `step-summary-writer`
- **WHEN** the continuation records a call and ends
- **THEN** the token counters and the iteration histogram MUST carry `agent_id: "step-summary-writer"`, not the id of the step agent

#### Scenario: A replayed step does not count again

- **GIVEN** a run whose steps a recovery replays from the step store
- **WHEN** each replayed step returns its stored reply
- **THEN** the token counters MUST NOT grow for the replayed calls
- **AND** the usage records of the replayed calls MUST carry the same keys as the records of the first run

#### Scenario: Reasoning tokens reach their counter

- **GIVEN** a response whose usage reports 40 reasoning tokens
- **WHEN** the loop records the call
- **THEN** `cortex.harness.agent.reasoning_tokens` MUST grow by 40

#### Scenario: Every call reaches the recorder

- **GIVEN** a run of some LLM calls that ends in a forced wrap-up
- **WHEN** the run completes
- **THEN** the injected `UsageRecorder` MUST hold one attributed record for each call, the wrap-up calls included

#### Scenario: A recorder err does not change the run

- **GIVEN** a run whose `UsageRecorder` gives an `err` for each record
- **WHEN** the run completes
- **THEN** the loop logs the reason of each `err` at the error level
- **AND** the run has the same finish reason and the same usage rollups as a run whose recorder succeeds

### Requirement: runAgent sends a reasoning value only when its caller gives one

`RunAgentOptions` MUST accept an optional `reasoning: ReasoningPolicy`. When the caller gives a value, the loop MUST send
it on each call of the run, the forced wrap-up included. When the caller gives no value, the loop MUST leave
`ChatRequest.reasoning` unset. The provider then applies its configured effort, as the harness-providers capability
describes.

The loop MUST NOT apply `DEFAULT_REASONING` itself. A default in the loop hides the effort of the provider
configuration. The loop sends one value, or no value, on each call of a run. Thus the effort stays the same for each
call of one conversation.

#### Scenario: A run without a value sends none

- **WHEN** `runAgent` is invoked without `reasoning`
- **THEN** no request of the run carries `reasoning`, the wrap-up included

#### Scenario: A run with a value sends it on each call

- **WHEN** `runAgent` is invoked with `reasoning: "low"`
- **THEN** each request of the run carries the reasoning `low`, the wrap-up included

### Requirement: The tool-finished observation reports a three-way outcome

The loop's `tool-finished` event SHALL report `outcome: "ok" | "error" | "denied"` rather than a boolean error flag. `denied` SHALL be reported when the tool result is `execution-denied`; `error` SHALL be reported for an error tool result from a thrown failure, an `err(ToolError)`, or rejected input; `ok` SHALL be reported otherwise.

The loop already distinguishes a denial from a recoverable tool error in its control flow — a denial hard-stops the turn, while an error is one the model reads and retries around. Folding both into one flag loses that distinction at the observation boundary, so a user who rejects an approval sees their own decision reported as a fault. A single three-state field SHALL carry it, rather than two booleans that can express the impossible combination.

#### Scenario: A denied approval is reported as denied, not as an error

- **GIVEN** a turn in which a tool's approval request is answered `reject`
- **WHEN** the loop emits that call's finished event
- **THEN** the event reports `outcome: "denied"`

#### Scenario: A thrown tool failure is reported as an error

- **GIVEN** a tool whose execution throws a non-fatal error
- **WHEN** the loop emits that call's finished event
- **THEN** the event reports `outcome: "error"`

#### Scenario: Rejected input is reported as an error

- **GIVEN** a tool call whose input fails the tool's Zod schema and cannot be repaired
- **WHEN** the loop emits that call's finished event
- **THEN** the event reports `outcome: "error"` and the tool was never executed

#### Scenario: A successful call is reported as ok

- **GIVEN** a tool that returns an `ok` data variant, including an expected "not found" outcome
- **WHEN** the loop emits that call's finished event
- **THEN** the event reports `outcome: "ok"`

### Requirement: The declared tools stay fixed for each request of a conversation

A conversation MUST send `AgentDefinition.tools` and the `toolChoice` of the run with no change on each request. A conversation is the message list of one agent under one system prompt. It holds the loop requests, the wrap-up requests, the salvage requests, and the requests of each continuation. The loop MUST NOT add, remove, or reorder a declared tool inside a conversation. It MUST NOT change `toolChoice` inside a conversation. A mask limits which tools run, not which tools a request declares.

Some models bind each signed thinking block to the exact prefix: the system prompt, the tool set, and the earlier messages. A change of the tool set makes each later block invalid, and the prompt cache misses.

#### Scenario: Each request of a run declares the same tools

- **GIVEN** a run of 3 loop requests that ends with a wrap-up of 2 requests
- **WHEN** the loop sends each request
- **THEN** the 5 requests carry byte-identical `tools` and the same `toolChoice`

#### Scenario: A continuation declares the tools of its conversation

- **GIVEN** a continuation of a conversation, with a mask that lets one tool run
- **WHEN** the continuation sends its request
- **THEN** the request declares each tool of the agent, in the same order as the requests of the conversation

### Requirement: A tool mask and a tool budget limit the calls that run

`RunAgentOptions` MUST accept an optional `toolMask` and an optional `toolBudget`. A mask is `"none"`, or the list of the ids of the tools that can run for a request. A budget maps a tool id to the maximum count of calls of that tool in one run. Without a mask, each declared tool can run. A tool with no budget entry has no limit.

The loop MUST apply the mask and the budget at dispatch, in the order of the calls of a round. A call passes when the mask names its tool and the budget of its tool has a unit left. A call that passes MUST use one unit of the budget, whatever its result. The count includes the earlier calls of the same round.

A call that the mask refuses, or a call past the budget of its tool, MUST get an error result that gives the reason. Its tool MUST NOT run. The loop MUST emit the `tool-started` and `tool-finished` pair of a refused call, with the outcome `error`.

The loop MUST give the refusal inside the step wrapper that a dispatched call of the same tool id gets, under the same step name. A step-mode tool and an unknown tool id get a durable step. An inline-mode tool gets no wrapper. Thus the step sequence of a round is the same with and without the mask. An earlier build dispatched a call of an undeclared tool as an unknown tool, in a step. When this build declares that tool as a step-mode tool and refuses the call, a replay finds the recorded step.

Both dispatch paths MUST apply the same check: the normal round and the round that a truncation cut. The check is a pure function of the mask, the budget, and the calls of the run. Thus a replay refuses the same calls. Provider-native masking, for example OpenAI `allowed_tools`, is out of scope, and each request declares the full tool set.

#### Scenario: A call outside the mask does not run

- **GIVEN** a run whose mask names only `read_file`
- **WHEN** the model calls `write_file`
- **THEN** `write_file` does not run, the call gets an error result that names the mask, and the loop continues

#### Scenario: The budget refuses a call past its limit

- **GIVEN** a run with the budget `{ literature_reviewer: 3 }` whose model calls `literature_reviewer` in 4 rounds
- **WHEN** the loop dispatches the fourth call
- **THEN** the call gets an error result that gives the limit of 3, and the tool does not run

#### Scenario: The budget counts the calls of the same round

- **GIVEN** a run with the budget `{ literature_reviewer: 3 }` that ran 2 calls of that tool
- **WHEN** one reply calls `literature_reviewer` 2 times
- **THEN** the first call of the reply runs, and the second call gets the error result of the budget

#### Scenario: A refused call keeps the step of its tool

- **GIVEN** a durable run whose mask refuses a step-mode tool
- **WHEN** the model calls that tool
- **THEN** the refusal runs inside the step of a dispatched call of that tool, under the same step name
- **AND** the tool does not run, and a replay of the run returns the error result from that step

#### Scenario: A step of an earlier build replays

- **GIVEN** a durable run that an earlier build recorded, whose agent did not declare a step-mode tool that the model called
- **WHEN** this build replays the run with the tool declared and refused by the mask
- **THEN** the refusal takes the recorded step of the call, and the replay gives the recorded result

#### Scenario: No mask lets each declared tool run

- **WHEN** `runAgent` runs with no `toolMask` and no `toolBudget`
- **THEN** each call of a declared tool dispatches as before

### Requirement: A continuation extends an existing conversation of an agent

The harness MUST give one operation, `continueAgent`, that continues an existing conversation of an agent with one harness request. The operation MUST take these inputs:

- the agent definition of the conversation
- the messages of the conversation
- the text of the harness request
- a mask and a cap of requests
- a step-name namespace
- an optional accounting agent id

The operation MUST append the text as a synthetic user message. Thus the request opens no turn in a stored thread. Then it MUST run the loop over the conversation and the request. It MUST send the system prompt, the declared tools, and the `toolChoice` of the conversation with no change. The caller MUST give the provider and the `reasoning` value of the conversation. Thus the prompt cache reads the prefix, and each earlier thinking block stays valid.

The operation MUST return only the new messages, from the request to the end, and its finish. It MUST NOT change a message of the conversation. It MUST NOT run a wrap-up at its own cap. At the cap, its finish MUST report `"max_iterations"` with `cappedOut: true`.

A continuation MUST name each step `<namespace>:<name>`, where `<name>` is the name that the step formatter of the caller gives. Thus a durable cache key of a continuation cannot match a key of its conversation. With an accounting agent id, the continuation MUST run under `forSubAgent(session, id)`, thus its usage records carry that id. Its token counters and its run metrics MUST carry that id in place of the `id` of the agent definition.

#### Scenario: The request extends the prefix of the conversation

- **GIVEN** a conversation of an agent that ended on a text reply
- **WHEN** a continuation sends its first request
- **THEN** the request carries the system prompt and the tools of the conversation, and its messages start with each message of the conversation, byte-identical

#### Scenario: The continuation returns only its new messages

- **GIVEN** a conversation of 6 messages and a continuation that ends after one text reply
- **WHEN** the continuation returns
- **THEN** its `messages` hold the synthetic request and the reply, and the 6 messages of the conversation are unchanged

#### Scenario: The cap ends a continuation with no wrap-up

- **GIVEN** a continuation with a cap of 2, whose model calls a refused tool in each reply
- **WHEN** the continuation runs
- **THEN** it sends exactly 2 requests, and its finish reports `"max_iterations"` with `cappedOut: true`

#### Scenario: The accounting id reaches the record

- **GIVEN** a continuation with the accounting agent id `step-summary-writer` under a step session
- **WHEN** its call completes with usage
- **THEN** the usage record carries the `agentId` `step-summary-writer`, and the `runId` and the `stepId` of the step

#### Scenario: The step names carry the namespace

- **GIVEN** a continuation with the namespace `file-metadata` and the default step formatter
- **WHEN** it makes its first model call
- **THEN** the step name is `file-metadata:llm-0`

### Requirement: The loop answers each unanswered tool call at its exit

At each exit, the loop MUST give a not-run error result to each tool call of its own messages that has no result. The result text MUST be one constant that states that the turn ended before the call ran. The loop MUST append one `tool` message with these results after the assistant message of the calls. It MUST NOT remove or change a message, and it MUST NOT run the calls. The loop MUST NOT answer a call that the provider ran, because the provider gives its result in the same message.

This rule covers each exit: a clean stop, an abort, a denial, a resolved outcome, and the end of the wrap-up. A reply can carry a complete tool call beside any finish reason, because the call streams before the finish reason arrives. The result states a fact, and it records no execution that did not occur.

#### Scenario: A filtered reply keeps its call and gets a not-run result

- **GIVEN** a reply with the finish reason `content-filter` that carries prose and one tool call
- **WHEN** the loop returns
- **THEN** the assistant message keeps the prose and the call, a `tool` message with the not-run result follows it, and the tool did not run

#### Scenario: An aborted partial keeps its call

- **GIVEN** an aborted reply whose partial carries a complete tool call
- **WHEN** the loop returns
- **THEN** the partial carries the interruption marker, a `tool` message with the not-run result follows it, and `finish.reason` is `"aborted"`

#### Scenario: The loop and the history load give the same result

- **GIVEN** the same unanswered call at the exit of a run and in a stored window
- **WHEN** the loop and the chat-turn history load each answer it
- **THEN** the two results are byte-identical

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

### Requirement: The loop cuts a long tool result before the result joins the transcript

The loop MUST measure the text of each result that `dispatchTool` makes, before the result joins a `tool` message. The text is the text that the model reads:

- The text of a `json` or an `error-json` result is the JSON text of its value.
- The text of a `text` or an `error-text` result is its value.
- The text of a `content` result is its text part.

A denial result MUST keep its text, because a denial ends the turn with the words of the user. The loop MUST count a length in UTF-16 code units, the unit of a JavaScript string length. This requirement calls such a unit a character.

When the text is longer than the cap of 32,768 characters, the loop MUST replace the text with an excerpt. The excerpt MUST hold these parts, in this order:

- a line that states the cut, the length of the text, the cap, and the lengths of the two parts that it shows
- when the loop kept the text, a line that gives the reference, the length of the kept text, and the tool `read_tool_output`
- the first 4,096 characters of the text
- a marker line that gives the count of the characters that the excerpt does not show
- the last 8,192 characters of the text

When the loop did not keep the text, the first line MUST state that the rest is not kept. A cut point MUST NOT split a surrogate pair.

A `json` or a `text` result MUST become a `text` result with the excerpt. An `error-text` or an `error-json` result MUST become an `error-text` result with the excerpt. A `content` result MUST keep its file parts after the excerpt, thus a picture keeps its placement. The cut MUST NOT change the outcome of `tool-finished`.

The cut MUST run in `dispatchTool`, the one function that makes the result of a dispatched call. Thus both dispatch paths and each segment of a conversation obey one rule, and no tool carries its own code for the cut. For a step-mode tool, the cut runs inside the durable step of the call. Thus the step output holds the excerpt, and a replay gives the same excerpt.

The excerpt MUST be a function of the text, the reference, and the decision to keep the text. Thus a call that runs again gives the same bytes. An inline-mode tool on a replay, and a step that did not complete before a recovery, are examples.

#### Scenario: A result at the cap stays whole

- **GIVEN** a tool whose result has a JSON text of 32,768 characters
- **WHEN** the loop dispatches the call
- **THEN** the result is the `json` result with no change

#### Scenario: A long result becomes an excerpt

- **GIVEN** a `read_file` result with a JSON text of 262,200 characters, and a run with no store
- **WHEN** the loop dispatches the call
- **THEN** the result is a `text` result that starts with the line of the cut, and that line states that the rest is not kept
- **AND** the excerpt holds the first 4,096 and the last 8,192 characters, and its marker line gives the count 249,912

#### Scenario: The end of a failed command stays visible

- **GIVEN** an `execute_command` result with a stdout of 500,000 characters and a stderr that ends with a traceback
- **WHEN** the loop cuts the result
- **THEN** the excerpt ends with the traceback and the stream flags of the result

#### Scenario: An error result stays an error

- **GIVEN** a tool that throws an error with a message of 50,000 characters
- **WHEN** the loop dispatches the call
- **THEN** the result is an `error-text` result with the excerpt, and `tool-finished` reports the outcome `error`

#### Scenario: A picture keeps its placement

- **GIVEN** a provider that carries a picture in a tool result, and a result with a picture and a JSON text of 40,000 characters
- **WHEN** the loop cuts the result
- **THEN** the `content` result holds the excerpt and then the picture

#### Scenario: A replay gives the stored excerpt

- **GIVEN** a durable run whose step-mode tool gave a result of 100,000 characters
- **WHEN** the workflow replays
- **THEN** the step output gives the same excerpt, and the tool does not run again

### Requirement: The loop keeps the text of a cut result in an optional store

`RunAgentOptions` MUST accept an optional `toolOutputStore`, the same way as `usageRecorder`. The store is an interface of the loop layer. `put` keeps one text, and `get` gives the kept text of one reference in one analysis. The error type of each method MUST be `DomainError`. The loop MUST NOT know the realization of the store.

The loop MUST keep a text only when two conditions are true: the run has a store, and the agent declares `read_tool_output`. Then the loop MUST put a record before the result joins the transcript. The record holds these values:

- the analysis id of the session
- the reference
- the tool name and the tool call id
- the thread id of the session, only when the session has no run frame
- the kept text
- the length of the whole text

A run session carries the scope of the chat that started the run. Thus the loop MUST NOT give a thread id for a session with a run frame. A text of a run belongs to the analysis, and a text of a chat turn belongs to its thread.

The kept text MUST be the whole text when the text has at most 1,048,576 characters. A longer text MUST keep its first 524,288 and its last 524,288 characters. A marker line between the two parts MUST give the count of the dropped characters.

The key of a record MUST be `recordKeyFor` over the session, the invocation id of the run, and the tool step name of the call. The tool step name holds the tool call id. Under a run frame the key is the same on each replay, and in a chat turn it is a fresh id.

The reference MUST be `to_` and the first 20 hexadecimal characters of the SHA-256 hash of the key. The analysis id MUST be a part of the identity of a record. The data profile uses the same literal run id for each analysis. Thus only the analysis id keeps the records of two analyses apart.

A `put` MUST be an upsert on the analysis id and the reference. Thus a call that runs again on a replay or on a recovery writes the same row again. The excerpt MUST NOT depend on the outcome of the `put`. When a `put` gives an `err`, the loop MUST log one warn with the tool name and the reference, and the run continues.

When the run has no store, or the agent does not declare `read_tool_output`, the loop MUST keep nothing. The excerpt then states that the rest is not kept.

#### Scenario: The store gets the whole text

- **GIVEN** a run with a store, and an agent that declares `read_tool_output`
- **WHEN** a tool gives a result with a text of 100,000 characters
- **THEN** the store holds a record with the analysis id of the session, the whole text, and the length 100,000
- **AND** the second line of the excerpt gives the reference of that record

#### Scenario: A text of a chat turn names its thread

- **GIVEN** a chat session with the thread id `t-1` and no run frame, and a sub-agent loop of that turn
- **WHEN** each loop keeps a long result
- **THEN** each record carries the thread id `t-1`

#### Scenario: A text of a run names no thread

- **GIVEN** a run session whose scope carries the thread id of the chat that started the run
- **WHEN** a loop of the run keeps a long result
- **THEN** the record carries no thread id

#### Scenario: The record lands before the next request

- **GIVEN** a run with a store whose first reply calls a tool with a long result
- **WHEN** the loop sends the second model request
- **THEN** the store holds the record of that result

#### Scenario: An agent without the read tool keeps nothing

- **GIVEN** a run with a store, and an agent that does not declare `read_tool_output`
- **WHEN** a tool gives a long result
- **THEN** the store gets no `put`, and the excerpt states that the rest is not kept

#### Scenario: A replay writes the same record

- **GIVEN** a durable run whose step-mode call kept a long result, and a host that stopped before the step completed
- **WHEN** the step runs again on recovery
- **THEN** the loop puts the same reference and the same text, and the row does not change

#### Scenario: A failed put does not fail the run

- **GIVEN** a store whose `put` gives an `err`
- **WHEN** a tool gives a long result
- **THEN** the excerpt is the same as with a working store, the loop logs one warn, and the run continues

#### Scenario: A very long text keeps its start and its end

- **GIVEN** a result with a text of 3,000,000 characters
- **WHEN** the loop keeps the text
- **THEN** the kept text holds the first 524,288 characters, the marker line, and the last 524,288 characters
- **AND** the record holds the length 3,000,000

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

### Requirement: Tool dispatch runs step calls in parallel and folds the call records

Within one turn, the AI SDK loop integration MUST dispatch each tool call by the
execution mode of its tool. `step` tools MUST be wrapped as deterministic durable
steps, and they can run concurrently where AI SDK lets parallel tool calls occur.
A sandbox tool is a `step` tool, and its exec runs inside its tool step. `inline`
tools MUST run after the step tools, one at a time, with no step. Results MUST be
associated with the original tool-call ids.

After the whole round settles, the loop MUST give the call record of each call
to the `foldCallRecord` of its tool (see the harness-tools spec). It MUST fold
in the order of the tool calls. The parallel step calls settle in any order. Thus the fold
waits for the round, and a replay folds the same records in the same order. The
loop MUST fold on the first run and on each replay alike. A refused call, a
failed call, and an ok value with no record MUST reach no fold.

#### Scenario: Sandbox tools of one round run in parallel

- **GIVEN** a turn whose tool calls include two `execute_command` calls
- **WHEN** the loop dispatches them
- **THEN** each call runs as its own durable step, and the two steps run at the same time

#### Scenario: Step-backed tools cache through deterministic steps

- **GIVEN** a turn whose tool calls include external lookup tools
- **WHEN** the loop dispatches them
- **THEN** each lookup runs through a deterministic `runStep` wrapper and can cache-hit on DBOS replay

#### Scenario: Call records fold in call order

- **GIVEN** a round of two step calls `A` and `B` that carry records, where `B` settles first
- **WHEN** the round settles
- **THEN** the loop folds the record of `A`, and then the record of `B`

#### Scenario: A replayed round folds its records again

- **GIVEN** a round whose step calls completed, and a workflow that recovers in a new process
- **WHEN** the loop replays the round from the step cache
- **THEN** the loop folds the cached records in call order, and no tool runs `execute` again
