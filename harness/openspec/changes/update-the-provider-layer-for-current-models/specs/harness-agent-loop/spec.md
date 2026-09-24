## RENAMED Requirements

- FROM: `### Requirement: Cache token usage is recorded per run`
- TO: `### Requirement: Token usage is recorded for each call`

## MODIFIED Requirements

### Requirement: The loop caches its prompt prefix by default

`RunAgentOptions` MUST accept an optional `promptCache: PromptCachePolicy`. It MUST default to `DEFAULT_PROMPT_CACHE`
(`{ ttl: "5m" }`) when the caller supplies none. A host whose endpoint ignores cache directives, or charges badly for
them, MUST be able to pass `"off"`.

The loop MUST resolve the policy ONCE per run. An identical policy across every call is part of the cache contract,
because the prefix must be byte-identical to be read back.

The loop MUST place two breakpoints on each call, and MUST NOT attach a cache directive to the request itself:

- `withSystemPromptBreakpoint` marks the end of the system prompt. The system prompt of an agent depends only on its type, thus the loop can make the marked system prompt one time for each run.
- `withPromptCacheBreakpoint` marks the last message that can carry a directive. The transcript grows with each iteration, thus the loop places this breakpoint again on each call.

The placement of the message breakpoint MUST roll forward with the transcript. Each iteration appends the reply of the
model and the results of its tools. The next call then reads back what the last call wrote. A breakpoint pinned before
the tool messages makes each iteration send the whole tool transcript uncached.

The breakpoint at the end of the system prompt caches the tools and the system prompt as one entry. A new thread reads
that entry back. The first call after a shift of the message prefix also reads it back.

The forced wrap-up call MUST carry the same two breakpoints. It keeps the tool set of the loop, and it forbids a tool
call with `toolChoice: "none"`. Thus it keeps the prefix, and it reads the cached prefix back.

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

#### Scenario: The transcript the run returns is unmarked

- **WHEN** `runAgent` completes
- **THEN** no message of `AgentRunResult.messages` MUST carry a cache directive, because a host writes that array to a thread store

#### Scenario: A host opts out

- **WHEN** `runAgent` is invoked with `promptCache: "off"`
- **THEN** no LLM call it makes MUST carry a cache directive, on the system prompt, on a message, or on the request

### Requirement: Token usage is recorded for each call

The loop MUST record the token counters of each LLM call when that call completes, the forced wrap-up included. It MUST
NOT wait for the end of the run. Thus a run that throws keeps the count of the calls that completed before the throw.

The loop MUST record these counters:

- `cortex.harness.agent.input_tokens`
- `cortex.harness.agent.output_tokens`
- `cortex.harness.agent.cache_read_tokens`
- `cortex.harness.agent.cache_write_tokens`
- `cortex.harness.agent.reasoning_tokens`

Each counter MUST carry these labels:

- `agent_id`: the `agentId` of the usage record of the call.
- `model`: the `servedModelId` of the response. The label is absent when the response reports no served model.
- `provider`: the `provider` of the response. The label is absent when the response names no provider.

The loop MUST record only what a provider reports. A provider that reports no usage contributes nothing, not zero. The
reasoning counter counts `ChatUsage.reasoningTokens`. Providers do not agree on whether reasoning tokens are inside
`outputTokens`. The `provider` label keeps each series to one provider, thus one series sums figures of one meaning.

The iteration histogram and the cap-hit counter stay per run, with the `agent_id` label only. They describe a run, not
a call.

The loop MUST also deliver each LLM call to the injected `UsageRecorder` as an attributed usage record when the call
completes. It MUST surface its accumulated usage on its finish event. The root loop of a turn also surfaces the turn
total, with the descendant loops. The llm-usage-accounting capability gives the details. The counters, the records, and
the finish rollups are three surfaces over the same capture of each call. No surface replaces another, and the rule that
absent means "not reported" holds on all three.

The ad hoc router and the analogy conversion call `provider.chat` directly. They MUST use the same accounting path as
the loop, thus their calls reach the counters and the recorder.

The two cache counters make prompt caching observable. The hit rate of an agent type is
`cache_read_tokens / input_tokens`, because `inputTokens` is the total billed prefix. A read counter at zero beside a
write counter above zero shows a defeated cache. The cause is a prefix that shifts, or an endpoint that ignores cache
directives.

The loop MUST deliver each record through the notice helper of the host-hooks capability. The loop MUST NOT wait for
the result of `UsageRecorder.record`. When the result is an `err`, the loop MUST log the reason at the error level
through its `Logger`. The `err` MUST NOT change the outcome of the run.

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

#### Scenario: Reasoning tokens reach their counter

- **GIVEN** a response whose usage reports 40 reasoning tokens
- **WHEN** the loop records the call
- **THEN** `cortex.harness.agent.reasoning_tokens` MUST grow by 40

#### Scenario: Every call reaches the recorder

- **GIVEN** a run of some LLM calls that ends in a forced wrap-up
- **WHEN** the run completes
- **THEN** the injected `UsageRecorder` MUST hold one attributed record for each call, the wrap-up call included

#### Scenario: A recorder err does not change the run

- **GIVEN** a run whose `UsageRecorder` gives an `err` for each record
- **WHEN** the run completes
- **THEN** the loop logs the reason of each `err` at the error level
- **AND** the run has the same finish reason and the same usage rollups as a run whose recorder succeeds

## ADDED Requirements

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
