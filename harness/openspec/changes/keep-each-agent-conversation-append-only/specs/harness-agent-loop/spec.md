## MODIFIED Requirements

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

### Requirement: runToTerminal salvages a run that never reached its terminal tool

`runToTerminal` MUST run the agent. When the terminal-outcome cell is not resolved and the run was not aborted, it MUST run exactly one salvage continuation. The salvage continuation MUST keep the declared tools of the agent, and its mask MUST let only the terminal tools run. Its request MUST be the corrective nudge. Its step names MUST carry the namespace `salvage`, thus a durable caller does not use the cache slots of the first run again. When the run resolved, or when it was aborted, `runToTerminal` MUST return the result of the first run with no change.

`runToTerminal` MUST throw when a terminal tool is not a declared tool of the agent, because a mask cannot let an undeclared tool run.

A salvage continuation that starts MUST be reported at `warn` through the `Logger` of the loop, because the agent ended without its terminal outcome. Only `runToTerminal` can report this. The loop sees the salvage as a continuation with a small cap and a mask. It cannot know that the salvage is a second attempt.

#### Scenario: An agent that never submits gets one salvage continuation

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

## ADDED Requirements

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

The loop MUST give the refusal inside the step wrapper that a dispatched call of the same tool id gets, under the same step name. A step-mode tool and an unknown tool id get a durable step. A workflow-mode tool and an inline-mode tool get no wrapper. Thus the step sequence of a round is the same with and without the mask. An earlier build dispatched a call of an undeclared tool as an unknown tool, in a step. When this build declares that tool as a step-mode tool and refuses the call, a replay finds the recorded step.

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
