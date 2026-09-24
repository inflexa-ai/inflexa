## Why

Claude Opus 5.5 and Claude Fable 5.1 bind each signed thinking block to the exact prefix: the system prompt, the tool set, and the earlier messages. A change of that prefix makes each later block invalid, and the prompt cache misses.

A production audit of 16 days found that cache writes are 65% of the spend. Two post-step forks, `step-summary-writer` and `file-metadata-describer`, made 37% of all cache writes of the harness. Their hit rates were 40% and 21%, because each fork replays the transcript of the sandbox step under its own system prompt and tools. The loop also changes the prefix in three places: the wrap-up at the iteration cap, the salvage run of `runToTerminal`, and the strip of an unanswered tool call.

## What Changes

- The declared tools of an agent stay the same for each request of one conversation. The loop never changes `tools` or `toolChoice` inside a conversation.
- A tool mask and a tool budget become one loop component. A mask gives the tools that can run for a request. A budget gives the maximum count of calls of a tool in a run. The loop refuses each other call at dispatch with an error result, and the tool does not run.
- A new operation, `continueAgent`, continues an existing conversation of an agent with one harness request, under a mask and a small cap. It keeps the system prompt, the declared tools, the tool choice, the provider, and the effort. It returns the new messages and the finish.
- The wrap-up at the iteration cap becomes a continuation with the mask `"none"`. It keeps `toolChoice`, because `@ai-sdk/anthropic` removes the tools from a request with `toolChoice: "none"`.
- The salvage run of `runToTerminal` becomes a continuation with the full declared tools and a mask of the terminal tools.
- The loop gives a "not run" error result to each unanswered tool call at its exit. The chat-turn history load gives the same result to a stored unanswered call. The strip of `src/memory/tool-call-integrity.ts` goes away.
- The file metadata and the step summary become continuations of the conversation of the sandbox agent. Both continuations let `read_file` and `grep` run. Each step agent declares `submit_file_metadata` from its first request, and the task masks it.
- The analogical reasoner submits its report through `submit_analogy_report`, or a failure through `report_blocker`, the same pattern as the planner. The conversion call and the parse repair go away.
- The run synthesis gets a budget of 3 calls of `literature_reviewer`.

## Capabilities

### New Capabilities

- `analogy-report`: the analogical reasoner submits its report or a blocker through two terminal tools, with one salvage continuation.

### Modified Capabilities

- `harness-agent-loop`: the fixed tool set of a conversation, the tool mask and the tool budget, and the continuation. Also the wrap-up, the salvage, the answer to an unanswered call, and the wrap-up rule of the prompt cache.
- `harness-thread-history`: the chat-turn history load answers a stored unanswered tool call.
- `harness-sandbox-agents`: the substrate declares `submit_file_metadata`, and the two post-step producers continue the conversation of the step agent.
- `per-agent-tool-allowlist`: the substrate names `submit_file_metadata`.
- `step-interpretation-summary`: the step summary is a continuation whose mask lets only `read_file` and `grep` run.
- `planning-enhancements`: the salvage of the planner keeps the declared tools under a mask.
- `literature-reviewer`: the salvage of the synthesizer keeps the declared tools under a mask, and the synthesis limits `literature_reviewer` to 3 calls.
- `llm-usage-accounting`: a continuation produces its records under its accounting id, and the analogy conversion call goes away.

## Impact

Harness source:

- `src/loop/run-agent.ts`, `src/loop/types.ts`, `src/loop/run-to-terminal.ts`, and the new `src/loop/tool-mask.ts` and `src/loop/continue-agent.ts`.
- `src/memory/tool-call-integrity.ts` and `src/app/message-assembly.ts`.
- `src/providers/types.ts` and `src/providers/prompt-cache.ts`, for the comments only.
- The new `src/tools/sandbox/submit-file-metadata.ts`, and `src/agents/sandbox/shared.ts`, `src/workflows/sandbox-step.ts`, and `src/execution/post-step-pipeline.ts`.
- `src/execution/artifact-metadata.ts` and `src/execution/step-summary.ts`.
- `src/tools/research/generate-analogy-report.ts`, `src/prompts/analogical-reasoner.ts`, and the header of `src/tools/sandbox/report-blocker.ts`.
- `src/execution/run-synthesis.ts`.
- `CONTEXT.md`.

Consumers:

- `SandboxAgentBuildContext` gets the field `fileMetadata`. An embedder must give it to `SandboxAgentDeps` in its `buildAgent`. Without it, each file of a step gets the fallback description, and the step logs a warn.
- `cli/src/modules/harness/run_deps.ts` gives the cell to the agent, and `cli/src/modules/harness/run_deps.test.ts` adds the field to its build context. CI links the working-copy harness, thus the two files change in this change.
- Cortex gives the cell in its `buildAgent` when it bumps the pin.
- A thread display shows a call that did not run as an error result. Before, the call disappeared from the stored thread.

This change builds on `update-the-provider-layer-for-current-models`. Two deltas use the text of that change, thus that change archives first.

Release. The user starts the harness release after the merge. The change does not change the version in `package.json`.
