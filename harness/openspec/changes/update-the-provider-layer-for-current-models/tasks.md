# Tasks

Each path is relative to `harness/`. A path that starts with `cli/` is relative to the root of the repository.

## 1. Bump the AI SDK packages

- [ ] 1.1 In `package.json`, set the eight AI SDK packages to their latest npm releases in one edit. Keep the caret ranges, and keep the exact pin of `@ai-sdk/provider-utils`. On 2026-09-24 the latest releases are these:
  - `ai`: `^7.0.113`
  - `@ai-sdk/anthropic`: `^4.0.62`
  - `@ai-sdk/openai`: `^4.0.74`
  - `@ai-sdk/openai-compatible`: `^3.0.55`
  - `@ai-sdk/otel`: `^1.0.113`
  - `@ai-sdk/provider`: `^4.0.18`
  - `@ai-sdk/provider-utils`: `5.0.47`
  - `@ai-sdk/amazon-bedrock` (dev): `^5.0.93`
- [ ] 1.2 Run `npm view <package> version dependencies` for each package. If a newer release exists, use it. Make sure that each package depends on the same exact `@ai-sdk/provider` and `@ai-sdk/provider-utils`. `@ai-sdk/otel` pins `ai` exactly, thus the two move together.
- [ ] 1.3 Run `bun install`. Make sure that `bun.lock` holds one copy of each of `@ai-sdk/provider` and `@ai-sdk/provider-utils`. Expected result: `grep -n '"[^"]*/@ai-sdk/provider' bun.lock` prints nothing.
- [ ] 1.4 Run `tsc -p tsconfig.json`. Fix each error at its site in `src/`, with no change of behavior. If a fix changes behavior, stop and report it to the user.
- [ ] 1.5 Run `bun test src/providers src/loop`. Expected result: the same tests pass as before the bump.
- [ ] 1.6 Run `bun run format:file` on each file under `src/` that 1.4 or 1.5 changed.

## 2. The effort on the provider configuration

- [ ] 2.1 In `src/providers/ai-sdk.ts`, add `readonly reasoning?: ReasoningPolicy` to each of the three arms of `AiSdkProviderConfig`. Add the same field to `AiSdkProviderDeps`. The doc comment says that the value applies to each call whose request sets no `reasoning`.
- [ ] 2.2 In `createConfiguredAiSdkProvider`, give `config.reasoning` to `createAiSdkProvider` in each arm, only when the config sets it.
- [ ] 2.3 In `createAiSdkProvider`, select the effort of each call as `req.reasoning ?? deps.reasoning ?? DEFAULT_REASONING`. Give that value to the two `streamText` calls, in `chat` and in `chatStream`, in place of `req.reasoning`.
- [ ] 2.4 In `src/loop/run-agent.ts`, remove the import of `DEFAULT_REASONING` and the constant `reasoning` of `runAgentLoop`. In the loop request and in the wrap-up request, add `reasoning` only when `opts.reasoning` is set. Expected result: a run without `opts.reasoning` sends requests with no `reasoning` key.
- [ ] 2.5 Write these doc comments again for the order of the effort: `RunAgentOptions.reasoning` in `src/loop/run-agent.ts`, `ChatRequest.reasoning` in `src/providers/types.ts`, and the module header and `DEFAULT_REASONING` in `src/providers/reasoning.ts`. Also write again the comment above the export of `DEFAULT_REASONING` in `src/index.ts`. Each comment gives the order: the request, the provider configuration, then `DEFAULT_REASONING`. Keep the CAUTION on the vendor keys in `src/providers/types.ts`.
- [ ] 2.6 In `src/providers/ai-sdk.test.ts`, add three tests of the order. Use `fakeModel` to record `LanguageModelV4CallOptions.reasoning`. Expected result: a request value wins, then a configured value applies, then `xhigh` applies.
- [ ] 2.7 In `src/providers/configured-provider.barrel.test.ts`, change `capturingFetch` to record the whole body and the headers of each request. Add a test: an `anthropic` config with `reasoning: "high"`, bound to `claude-opus-5-5`, sends `output_config.effort: "high"`.
- [ ] 2.8 In `src/loop/prompt-cache.test.ts`, change the tests of `describe("runAgent reasoning directive")`, and the `xhigh` assertion of the test that turns caching off. Expected result: a run without `reasoning` sends no `reasoning`, and an explicit value reaches each call, the wrap-up included.
- [ ] 2.9 Run `tsc -p tsconfig.json`. Run `bun test src/providers/ai-sdk.test.ts src/providers/configured-provider.barrel.test.ts src/loop/prompt-cache.test.ts src/loop/run-agent.test.ts`. Then run `bun run format:file` on each changed file under `src/`.

## 3. The session key

- [ ] 3.1 In `src/providers/ai-sdk.ts`, add `export function sessionKeyOf(session: Pick<AgentSession, "scope" | "runFrame">): string`. The doc comment says that the key holds only identifiers, because the key goes to the vendor. The function gives the key of the first rule that applies:
  - A run frame with a step gives `<analysisId>:<runId>:<stepId>`.
  - A run frame without a step gives `<analysisId>:<runId>`.
  - A scope with a thread gives `<analysisId>:<threadId>`.
  - Else, the key is `<analysisId>`.
- [ ] 3.2 In `src/providers/ai-sdk.ts`, add `interface ProviderCall` with `session: AgentSession` and `reasoning: ReasoningPolicy`. Add `readonly providerOptionsFor?: (call: ProviderCall) => ProviderOptions | undefined` to `AiSdkProviderDeps`. The `reasoning` of the call is the effort that 2.3 selects.
- [ ] 3.3 In `chat` and in `chatStream` of `createAiSdkProvider`, call `providerOptionsFor` one time for each call, before the retry envelope. Give the result to `streamText`, merged over `req.providerOptions` for each namespace. Group 7 removes `req.providerOptions`.
- [ ] 3.4 In `createConfiguredAiSdkProvider`, give each arm its `providerOptionsFor`. The `anthropic` arm gives `{ anthropic: { metadata: { userId: sessionKeyOf(session) } } }`. The `openai` arm gives `{ openai: { promptCacheKey: sessionKeyOf(session) } }`. The `openai-compatible` arm gets no function.
- [ ] 3.5 In `src/providers/ai-sdk.test.ts`, add a table test of `sessionKeyOf` for the four rules. Add a test that a session and its `forSubAgent` child give the same key. Add a test that a scope with a thread and a run frame without a step gives `<analysisId>:<runId>`.
- [ ] 3.6 In `src/providers/configured-provider.barrel.test.ts`, add wire tests. Expected result: the `anthropic` body carries `metadata.user_id`, the `openai` body carries `prompt_cache_key`, and the `openai-compatible` body carries neither.
- [ ] 3.7 In `src/providers/ai-sdk.openai-arm.test.ts`, add a test that the call options carry `promptCacheKey` and `store` together. `withStoreDirective` spreads the `openai` namespace already, thus no source change is necessary.
- [ ] 3.8 Run `tsc -p tsconfig.json`. Run `bun test src/providers/ai-sdk.test.ts src/providers/ai-sdk.openai-arm.test.ts src/providers/configured-provider.barrel.test.ts`. Then run `bun run format:file` on each changed file under `src/`.

## 4. The thinking-binding mode and the drop log

- [ ] 4.1 Read the wire shape of the installed package, in `node_modules/@ai-sdk/anthropic/src/anthropic-language-model.ts`. Read `resolveAnthropicReasoningConfig`, `getModelCapabilities`, and the merge of `providerOptions.anthropic.thinking` below the comment "Map top-level `reasoning`". Make sure that these facts of version `4.0.62` still hold:
  - A model with `rejectsThinkingDisabled` always thinks. These models are `claude-opus-5-5`, `claude-fable-5`, and `claude-fable-5-1`. The `none` effort sends `output_config.effort: "low"` to such a model.
  - A model that can turn thinking off gets `thinking: { type: "disabled" }` for the `none` effort.
  - The package applies its own `thinking` selection only when `providerOptions.anthropic.thinking` is absent. Thus a binding without a `type` removes `type` and `display` from the body, and the API applies the default thinking mode of the model.
  - Write down the `type` and the `display` that the package sends to a model with `rejectsThinkingDisabled` for each effort value, when no `providerOptions.anthropic.thinking` is present. Task 4.4 uses these values.
- [ ] 4.2 If 4.1 shows a different wire shape, stop. Report the difference to the user, and wait for a decision.
- [ ] 4.3 In `src/providers/ai-sdk.ts`, add `readonly thinkingBinding?: "drop_block" | "error" | "off"` to the `anthropic` arm of `AiSdkProviderConfig`. The doc comment gives the three modes, the default `drop_block`, the beta header `thinking-binding-controls-2026-08-01`, and the gateway that needs `off`.
- [ ] 4.4 In the `anthropic` `providerOptionsFor` of `createConfiguredAiSdkProvider`, add `thinking: { type, display, blockBinding: { prefixMismatchBehavior: mode } }` only on a request that runs with thinking. `type` and `display` are the values that 4.1 wrote down, thus the body keeps the thinking selection of the package. Use this rule: the mode is not `off`, and `getModelCapabilities(config.model).rejectsThinkingDisabled` is `true`. Import `getModelCapabilities` from `@ai-sdk/anthropic/internal`, with a comment that names the hidden constraint of 4.1. Expected result: the binding never changes whether a request thinks.
- [ ] 4.5 In `createAiSdkProvider`, read `providerMetadata.anthropic.inputTransformations` after the drain of the stream. Do this in `chat` and on the two terminal paths of `chatStream`. Log one `logger.warn("thinking block dropped", …)` for each entry, with `workload`, `type`, `path`, and `reason`. In `chat`, log after the retry envelope resolves, thus only the attempt that succeeded logs.
- [ ] 4.6 In `src/providers/configured-provider.barrel.test.ts`, add wire tests with the changed `capturingFetch`:
  - For `claude-opus-5-5` at `xhigh` with no mode, the body carries `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` and `output_config.effort: "xhigh"`. The `anthropic-beta` header holds `thinking-binding-controls-2026-08-01`.
  - For `claude-opus-5-5` at `none`, the body carries the binding and `output_config.effort: "low"`.
  - For `thinkingBinding: "error"`, the body carries `"error"`.
  - For `thinkingBinding: "off"`, the body and the headers carry no binding.
  - For `claude-opus-4-7` at `xhigh`, the body carries `thinking.type: "adaptive"` and no binding.
  - For `claude-sonnet-4-5` at `none`, the body carries `thinking.type: "disabled"` and no binding.
- [ ] 4.7 In `src/providers/ai-sdk.test.ts`, add tests of the drop log with a logger that records each call. The fake model gives `providerMetadata.anthropic.inputTransformations` on its finish part. Expected result: one warn record for each entry, on `chat` and on `chatStream`, and `chat` returns `ok`.
- [ ] 4.8 Run `tsc -p tsconfig.json`. Run `bun test src/providers/ai-sdk.test.ts src/providers/configured-provider.barrel.test.ts`. Then run `bun run format:file` on each changed file under `src/`.

## 5. The cache breakpoint at the end of the system prompt

- [ ] 5.1 In `src/providers/prompt-cache.ts`, add `export function withSystemPromptBreakpoint(system: string, policy: PromptCachePolicy): string | SystemModelMessage`. For a ttl policy, it gives `{ role: "system", content: system, providerOptions }`, with the options of `promptCacheProviderOptions(policy)`. For `"off"`, and for an empty `system`, it gives `system`, because the Anthropic API refuses an empty text block.
- [ ] 5.2 In `src/providers/types.ts`, change `ChatRequest.system` to `string | SystemModelMessage`, and import the type `SystemModelMessage` from `ai`. `src/providers/ai-sdk.ts` gives the value to `streamText` with no change.
- [ ] 5.3 In `runAgentLoop` of `src/loop/run-agent.ts`, make the marked system prompt one time, after the policy resolves. Use `withSystemPromptBreakpoint(agent.systemPrompt, promptCache)` as `system` in the loop request and in the wrap-up request.
- [ ] 5.4 Write the placement comments again for two markers. These are the section "What the Anthropic namespace does" of the header of `src/providers/prompt-cache.ts`, the doc comment of `withPromptCacheBreakpoint`, and the comment above the prompt-cache export in `src/index.ts`. Each comment says that a request holds two markers of the harness, and that the proxy counts both. Keep no claim that the Claude Max OAuth path ignores cache directives.
- [ ] 5.5 In `src/loop/prompt-cache.test.ts`, add unit tests of `withSystemPromptBreakpoint`. Expected result: a ttl policy gives both namespaces with the ttl, and `"off"` or an empty prompt gives the plain string.
- [ ] 5.6 In `src/loop/prompt-cache.test.ts`, add loop tests. Expected result: each request of a run, the wrap-up included, carries the same marked system message. With `"off"`, each request carries the plain string.
- [ ] 5.7 In the block `describe("the bedrock marker on the wire")` of `src/loop/prompt-cache.test.ts`, add a test that a `cachePoint` block comes after the system content. In `src/providers/configured-provider.barrel.test.ts`, add a test that the Anthropic body carries `cache_control` on the system text block.
- [ ] 5.8 In `src/providers/integration/anthropic-caching.integration.test.ts`, build `CACHED_REQUEST.system` with `withSystemPromptBreakpoint(LARGE_SYSTEM, DEFAULT_PROMPT_CACHE)`, the same as the loop builds it.
- [ ] 5.9 Run `tsc -p tsconfig.json`. Run `bun test src/loop/prompt-cache.test.ts src/loop/run-agent.test.ts src/providers/configured-provider.barrel.test.ts`. Then run `bun run format:file` on each changed file under `src/`.

## 6. Metrics for each call

- [ ] 6.1 In `src/providers/types.ts`, add `readonly provider?: string` to `ChatResponse`. The doc comment says that the value is the provider id of the bound model, as the AI SDK names it. The value is absent for a bare model-id string.
- [ ] 6.2 In `src/providers/ai-sdk.ts`, add `providerIdOf(model)` beside `requestedModelIdOf`. Set `provider` in `responseFromMessages` for `chat` and for the two paths of `chatStream`. Expected result: `anthropic.messages` for the `anthropic` arm, `openai.responses` for the `openai` arm, and `<name>.chat` for the `openai-compatible` arm.
- [ ] 6.3 In `src/loop/metrics.ts`, add the counter `cortex.harness.agent.reasoning_tokens` with the unit `{token}`. Add `export function recordChatCall(call: { readonly agentId: string; readonly response: ChatResponse }): void`. It adds each reported field of `response.usage` to its counter.
- [ ] 6.4 In `recordChatCall`, set the labels `agent_id`, `model` from `servedModelId`, and `provider` from `provider`. Omit a label whose value is absent.
- [ ] 6.5 In `src/loop/metrics.ts`, remove the token counters and the `usage` parameter from `recordAgentRun`. Keep the iteration histogram and the cap-hit counter, with the `agent_id` label only.
- [ ] 6.6 In `src/loop/metrics.ts`, write the module header and the doc comment of `AgentRunUsage` again. Describe the counters of each call, the three labels, and the reasoning counter with its `provider` label. Keep no claim that the Claude Max OAuth path ignores cache directives, because `src/providers/prompt-cache.ts` records that it does not.
- [ ] 6.7 In `src/loop/run-agent.ts`, move the closure `accountForCall` to an exported function `accountForChatCall(reply: ChatResponse, call: ChatCallAccounting): void`. `ChatCallAccounting` holds `session`, `agentId`, `callPath`, `stepName`, an optional `invocationId`, `usageRecorder`, `logger`, and `rollups: readonly AgentRunUsage[]`.
- [ ] 6.8 In `accountForChatCall`, fold the usage into each rollup, call `recordChatCall`, and deliver the record as the closure does now.
- [ ] 6.9 In `runAgentLoop`, call `accountForChatCall` at the two fold points, with `rollups: [usage, turnUsage]`. Remove `usage` from each `recordAgentRun` call. Expected result: the records and the finish rollups do not change.
- [ ] 6.10 In `src/tools/ad-hoc-router.ts`, add `readonly usageRecorder?: UsageRecorder` to `AdHocRouterDeps`. Add `readonly turnUsage?: AgentRunUsage` and `readonly invocationId?: string` to the `input` of `routeAdHocRequest`.
- [ ] 6.11 In `routeAdHocRequest`, make the router session one time with `forSubAgent`. After `provider.chat` gives `ok`, call `accountForChatCall`. Give it the router session, `AD_HOC_ROUTER_AGENT_ID`, the step name `adhoc-route`, `input.invocationId`, `input.turnUsage`, and the router `logger`. The recorder is `deps.usageRecorder`, else `createNoopUsageRecorder()`.
- [ ] 6.12 In `src/tools/execute-analysis.ts`, add `readonly usageRecorder?: UsageRecorder` to `ExecuteAnalysisToolDeps`. In `persistedAdHocPlan`, give the router `usageRecorder`, `turnUsage: args.ctx.turnUsage`, and `invocationId: args.ctx.invocationId`.
- [ ] 6.13 In `src/agents/conversation-agent.ts`, give `usageRecorder` to `createExecuteAnalysisTool`.
- [ ] 6.14 In `src/tools/research/generate-analogy-report.ts`, call `accountForChatCall` after the conversion `provider.chat` gives `ok`. Use `childSession`, `AGENT_ID`, the step name `analogy-conversion`, `ctx.invocationId`, the rollup `ctx.turnUsage`, and `createNoopLogger()`. The recorder is `deps.usageRecorder`, else `createNoopUsageRecorder()`.
- [ ] 6.15 In `src/loop/metrics.test.ts`, add tests. Expected result: the counters grow for each call with the three labels. A run that throws on its third call keeps the counts of the first two calls.
- [ ] 6.16 In `describe("runAgent cache-token metrics")` of `src/loop/prompt-cache.test.ts`, read the counters with the new labels. Add a test of the reasoning counter.
- [ ] 6.17 In `src/tools/ad-hoc-router.test.ts` and `src/tools/research/generate-analogy-report.test.ts`, add tests under a session with a `RunFrame`. Expected result: the direct call delivers one record whose key ends with its step name. The call also folds its usage into the turn accumulator.
- [ ] 6.18 Run `tsc -p tsconfig.json`. Run `bun test src/loop src/tools/ad-hoc-router.test.ts src/tools/execute-analysis.test.ts src/tools/research/generate-analogy-report.test.ts src/providers/ai-sdk.test.ts`. Then run `bun run format:file` on each changed file under `src/`.

## 7. Removals, streamed usage, and stale text

- [ ] 7.1 In `src/providers/types.ts`, remove `providerOptions` from `ChatRequest`. Keep the type export of `ProviderOptions`, because `src/providers/prompt-cache.ts` uses it.
- [ ] 7.2 In `src/providers/ai-sdk.ts`, give `streamText` only the result of `providerOptionsFor`. Remove the merge with `req.providerOptions`.
- [ ] 7.3 In `src/providers/ai-sdk.test.ts`, remove the test "forwards the request's providerOptions verbatim to the model". In `src/providers/ai-sdk.openai-arm.test.ts`, write the merge test near line 231 again without `ChatRequest.providerOptions`.
- [ ] 7.4 Delete `src/providers/anthropic.ts` and `src/providers/anthropic.test.ts`. In `src/index.ts`, remove the two exports of `./providers/anthropic.js`. Write the comment above the export of `createConfiguredAiSdkProvider` again, with the three kinds and no wrapper.
- [ ] 7.5 In `README.md`, remove the line of `createAnthropicProvider` from the list of the public surface.
- [ ] 7.6 In `cli/src/modules/harness/run_deps.test.ts`, replace `createAnthropicProvider` with `createConfiguredAiSdkProvider`. Use `{ config: { kind: "anthropic", baseURL: "http://proxy.test", apiKey: "t", model } }`. The `cli` jobs of CI link the working-copy harness, thus this test breaks without the change.
- [ ] 7.7 In `cli/src/modules/harness/runtime.ts`, change the comment near line 857. It names the `anthropic` arm of `AiSdkProviderConfig`, not the removed wrapper.
- [ ] 7.8 In `createConfiguredAiSdkProvider`, give `includeUsage: true` to `createOpenAICompatible`. In `src/providers/configured-provider.barrel.test.ts`, add a test that the `openai-compatible` body carries `stream_options.include_usage: true`.
- [ ] 7.9 In `src/providers/ai-sdk.ts`, write the doc comment of `DEFAULT_MAX_OUTPUT_TOKENS` again for the installed `@ai-sdk/anthropic`. For a known model id, the package clamps a larger value to the row of that model in `getModelCapabilities`. An unknown `claude-*` id defaults to 128000, and a non-Claude id defaults to 4096. Keep the paragraph on the `openai` arm.
- [ ] 7.10 In `src/tools/research/generate-analogy-report.ts`, make sure that no comment names `temperature`. Commit `4c29d52f` removed that note already, thus change nothing when it is absent.
- [ ] 7.11 In the header of `src/providers/prompt-cache.ts`, write the section "Cache defeaters" again for the current state. The forced wrap-up keeps the tool set and sends `toolChoice: "none"`, thus it keeps the prefix. Remove each sentence that describes a past state.
- [ ] 7.12 In the same section, state that `loadRecent` moves the window start in whole `EVICTION_BLOCK_TURNS` blocks. Thus the message prefix shifts one time for each block. Keep the paragraph on the system prompt of a sandbox agent.
- [ ] 7.13 In `src/tools/workspace/result-bounds.ts`, write the header paragraph and the doc comment of `EXEC_STREAM_BYTE_CAP` again. Name no loop result budget, because the harness has none. The cap of each stream alone bounds a result.
- [ ] 7.14 In `src/tools/workspace/execute-command.ts`, write the real cap in the `description` of `execute_command`. Make the text from `EXEC_STREAM_BYTE_CAP` (32 KiB), thus the two values cannot differ. In `src/tools/workspace/execute-command.test.ts`, assert that the description names `32 KiB`.
- [ ] 7.15 Run `tsc -p tsconfig.json`. Run `bun test src/providers src/tools/workspace src/tools/research/generate-analogy-report.test.ts`. Then run `bun run format:file` on each changed file under `src/`.
- [ ] 7.16 In `cli/`, run `bun run harness:local`, `bun run typecheck`, and `bun test src/modules/harness/run_deps.test.ts`. Then run `bun run format:file src/modules/harness/run_deps.test.ts src/modules/harness/runtime.ts`.

## 8. Final checks

- [ ] 8.1 Run `tsc -p tsconfig.json`. Expected result: no error.
- [ ] 8.2 Run `bun test`. Expected result: each unit test passes. A database suite needs Postgres, as the Testing section of `CLAUDE.md` describes.
- [ ] 8.3 Run `bun run lint`. Expected result: no error.
- [ ] 8.4 Run `grep -rn "createAnthropicProvider\|AnthropicProviderDeps" src README.md ../cli/src`. Expected result: no line.
- [ ] 8.5 Run `openspec validate update-the-provider-layer-for-current-models --strict` in `harness/`. Expected result: the change is valid.
- [ ] 8.6 Tell the user to archive `place-cache-breakpoint-on-last-message` before this change. Both changes modify the same two requirements, and the later archive replaces the text of the earlier one.
