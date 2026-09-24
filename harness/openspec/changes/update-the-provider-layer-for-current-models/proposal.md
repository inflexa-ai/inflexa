## Why

Claude Opus 5.5 and Claude Fable 5.1 are current Claude models. `@ai-sdk/anthropic` knows them from 4.0.60, but the harness pins 4.0.53. That version reads `claude-opus-5-5` as Claude Opus 5.

A cost audit of 16 days of production traffic found these problems in the provider layer:

- Each loop runs at `xhigh` effort, and the provider configuration has no effort field. Thus a host cannot give the coding agents one effort and the conversation agent a different effort.
- A request carries no session key. The production gateway sends the calls to different accounts, and each account has its own prompt cache. Thus a second call of one conversation can go to a different account and write the prefix again.
- The harness metrics have only the agent label. They have no model label and no provider label, and they do not count reasoning tokens. Thus the audit cannot split the cost by model.
- The loop records its counters only when a run ends. A run that throws loses the count of its completed calls. The ad hoc router and the analogy conversion record nothing.
- Claude Opus 5.5 and Claude Fable 5.1 bind each signed thinking block to the prefix that made it. After a change of that prefix, a replayed block gives HTTP 400 on an account made on or after 2026-08-31.
- Some paths of the harness still change the prefix, and a later change removes them. Until then, a request must continue without the block, and the harness must report the drop.
- A request has one cache breakpoint, on the last message. No breakpoint ends at the system prompt. Thus each new thread writes the tools and the system prompt again.

Some parameters and comments are stale:

- No production code sets `ChatRequest.providerOptions`.
- No production code calls `createAnthropicProvider`. One CLI test uses it, and Cortex does not use it.
- The OpenAI-compatible arm does not ask for usage on a stream. Thus most streamed calls report no usage.
- The description of `execute_command` gives a cap of 8 KiB. The real cap is 32 KiB.
- Three comments describe a state that is not true: the output-token note in `providers/ai-sdk.ts`, the list of cache defeaters in `providers/prompt-cache.ts`, and the loop result budget in `tools/workspace/result-bounds.ts`.

## What Changes

- Move the eight AI SDK packages to their latest releases together. Each package pins `@ai-sdk/provider` and `@ai-sdk/provider-utils` exactly. Thus the install keeps one copy of each.
- Each provider configuration takes an optional `reasoning`. The provider applies it to each request that does not set `ChatRequest.reasoning`. Without a configured value, the provider uses `DEFAULT_REASONING`.
- `runAgent` sends a reasoning value only when its caller gives one. Thus the configuration controls the loops.
- The provider sends a session key on each call. The Anthropic arm sends it as `metadata.user_id`. The OpenAI Responses arm sends it as `prompt_cache_key`.
- The key comes from an identifier string: `<analysisId>:<runId>:<stepId>` for a step, `<analysisId>:<runId>` for a run without a step, and `<analysisId>:<threadId>` for a chat thread. A sub-agent uses the key of its parent.
- The vendor gets the base64url SHA-256 digest of that string, with 43 characters. OpenAI and Azure refuse a `prompt_cache_key` longer than 64 characters, and the string of a step is longer. Anthropic recommends a hash or another opaque value for `metadata.user_id`.
- The Anthropic arm sends a thinking-binding mode: `drop_block` by default, `error`, or `off`. The provider logs each thinking block that the response reports as dropped, with its path and its reason.
- The prompt cache policy also marks the end of the system prompt. A request then holds two breakpoints of the harness.
- The harness metrics get the labels `model` and `provider`, and a counter for reasoning tokens. The loop records each call when the call completes.
- The ad hoc router and the analogy conversion record their usage and their metrics.
- The OpenAI-compatible arm asks for usage on a stream.
- **BREAKING** Remove `ChatRequest.providerOptions`.
- **BREAKING** Remove `createAnthropicProvider` and its export.
- Write the three stale comments again, and write the real cap in the description of `execute_command`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ai-sdk-provider-runtime`: the configuration carries the effort and the thinking-binding mode. The provider sends the session key. The OpenAI-compatible arm asks for streamed usage. The configuration path loses `createAnthropicProvider`.
- `harness-providers`: the order in which the provider selects the effort. The breakpoint at the end of the system prompt. The log of dropped thinking blocks. `ChatRequest` loses `providerOptions`.
- `harness-agent-loop`: `runAgent` sends a reasoning value only when its caller gives one. The loop records its metrics for each call.
- `llm-usage-accounting`: the two direct calls produce usage records.
- `harness-embedder-exports`: the root barrel loses `createAnthropicProvider`.

## Impact

Harness source:

- `package.json` and `bun.lock`.
- `src/providers/ai-sdk.ts`, `src/providers/types.ts`, `src/providers/reasoning.ts`, `src/providers/prompt-cache.ts`, and `src/providers/anthropic.ts`.
- `src/loop/run-agent.ts` and `src/loop/metrics.ts`.
- `src/tools/ad-hoc-router.ts` and `src/tools/research/generate-analogy-report.ts`.
- `src/tools/workspace/execute-command.ts` and `src/tools/workspace/result-bounds.ts`.
- `src/index.ts`.

Consumers:

- A host that takes this version must set the effort of each role. Without a value, each call runs at `xhigh`. The ad hoc router then runs at `xhigh` under its deadline of 10 seconds.
- `cli/src/modules/harness/run_deps.test.ts` uses `createConfiguredAiSdkProvider` instead of `createAnthropicProvider`. CI links the harness of the working copy, thus the test changes in this change.
- `cli/` adds an effort to each role of `models.agents` in its own change, together with the bump of its pin.
- Cortex adds an effort to its cloud configuration. The session key lets platform-charts #172 turn on the session affinity of cliproxy.
- The Anthropic arm sends the beta header `thinking-binding-controls-2026-08-01`. A gateway that refuses the header needs the mode `off`.

Release. The user starts the harness release after the merge. The change does not change the version in `package.json`.
