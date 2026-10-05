## Context

The harness runs each agent through `runAgent` (`src/loop/run-agent.ts`). A conversation is the message list of one agent under one system prompt and one tool set. Some models bind each signed thinking block to the exact prefix of its request. The first change of this series sends the thinking-binding mode `drop_block`, and it logs each dropped block. This change removes the prefix changes that cause the drops.

The code changes the prefix of a conversation at these sites:

- The wrap-up at the iteration cap sends `tools: toolDefs, toolChoice: "none"` (`src/loop/run-agent.ts` near line 552). `@ai-sdk/anthropic` 4.0.62 removes the tools from a request with `toolChoice: "none"` (`anthropic-prepare-tools.ts`). Upstream `vercel/ai#12378` closed as not planned. Anthropic also drops its message cache when `tool_choice` changes.
- The salvage run of `runToTerminal` gives the agent only the terminal tools (`src/loop/run-to-terminal.ts` near line 107). Its callers are `generate-plan.ts`, `run-synthesis.ts`, and `data-profile.ts`.
- `settleTranscript` strips each unanswered tool call from the messages of the run (`run-agent.ts` near line 288). `assembleMessages` strips them from the loaded window (`src/app/message-assembly.ts` near line 107). A strip changes an assistant message that the model wrote.
- `generateFileMetadata` and `generateStepSummary` run their own `AgentDefinition` over the transcript of the sandbox step (`src/execution/artifact-metadata.ts`, `src/execution/step-summary.ts`). Each fork has a different system prompt and a different tool set, thus each fork writes the full transcript to the cache again.

Two more sites make calls that are not necessary:

- The analogy report converts a text reply into its envelope with a second model call with no tools (`src/tools/research/generate-analogy-report.ts` near line 274).
- Each delegation of the synthesizer to `literature_reviewer` runs a full sub-agent loop. The iteration budget of the synthesizer plans for 1 to 3 delegations (`SYNTHESIZER_MAX_ITERATIONS` in `src/execution/run-synthesis.ts`). No code limits the count.

This change is the second of three. The first change, `update-the-provider-layer-for-current-models`, prepares the provider layer. It adds the session key, the effort on the provider configuration, and the metrics of each call. This change builds on its code and on the text of two of its deltas.

The first change states that the wrap-up still changes the prefix on the Anthropic arm. Its header of `src/providers/prompt-cache.ts` lists three defeaters of the cache: the wrap-up, the salvage run, and the two post-step forks. This change removes all three. The first change also grows the token counters inside the step body of each call, under `agent.id`.

## Goals / Non-Goals

**Goals:**

- Keep each agent conversation append-only: the same system prompt, the same tools, the same tool choice, and no change to an earlier message.
- Replace the two post-step forks with continuations of the conversation of the step agent.
- Give one loop component that limits the calls that run: the tool mask and the tool budget.

**Non-Goals:**

- Provider-native masking, for example OpenAI `allowed_tools` or Anthropic `tool_removal`.
- A save of each round, context records, the cache lifetime of each role, compaction, and large tool outputs. Later changes do them.
- The design of the first change names this change for the cache lifetime of each role. That work moves to a later change.

## Decisions

### A conversation declares the same tools on each request

Each request of a conversation sends `AgentDefinition.tools` and the `toolChoice` of the run with no change. This rule covers the loop requests, the wrap-up, the salvage run, and each continuation. The loop never sends `toolChoice: "none"`. A mask limits the calls that run, and it does not change the request.

This design rejects `toolChoice: "none"` for the wrap-up, because of the Anthropic facts in the Context section. It also rejects provider-native masking. The two vendors do it differently, and an embedder can send a role to an OpenAI-compatible endpoint that has neither.

### The tool mask and the tool budget

`src/loop/tool-mask.ts` holds the component. A mask is `"none"`, or `{ allow: readonly string[] }` with the ids of the tools that can run. A budget maps a tool id to the maximum count of calls of that tool in one run. `RunAgentOptions` takes `toolMask` and `toolBudget`. Without a mask, each declared tool can run. A tool with no budget entry has no limit.

The loop applies the check at dispatch, on both dispatch paths: the normal round and the round that a truncation cut. It reads the calls of a round in call order. A call passes when the mask names its tool and the budget of its tool has a unit left. A call that passes uses one unit, whatever its result. Thus with the budget 3, the fourth call fails, also when it is in the same round as the third.

A refused call gets an error result that gives the reason, and its tool does not run. The loop emits `tool-started` and `tool-finished` for it with the outcome `error`, the same as for an unknown tool. The counters of the run count it as a tool error.

The refusal runs inside the step wrapper that a dispatched call of the same tool id gets, under the same step name. A step-mode tool and an unknown tool id thus get a durable step, and a workflow-mode or inline-mode tool gets no wrapper. Thus the step sequence of a round is the same with and without the mask. The earlier build dispatched a call of an undeclared tool as an unknown tool, in a step. This build declares that tool and refuses the call. When the tool is step-mode, the refusal takes the recorded step, and the replay gives the recorded result.

The check is a pure function of the mask, the budget, and the calls of the run. Thus a durable replay refuses the same calls. A continuation counts only its own calls.

### The continuation

`continueAgent(agent, conversation, request, session, opts)` in `src/loop/continue-agent.ts` continues an existing conversation. The request holds the text, the mask, the cap of requests, the step namespace, and an optional accounting agent id. `opts` is `RunAgentOptions`. The caller gives the provider and the options of the conversation, thus the effort and the cache policy stay the same.

The operation appends the text as a synthetic user message (`syntheticUserMessage`). Thus the request opens no turn in a stored thread. Then it runs the loop with the system prompt, the declared tools, and the `toolChoice` of the conversation.

The operation returns only the new messages, from the request on, and the finish. It changes no earlier message. It runs no wrap-up at its own cap. At the cap, the finish reports `max_iterations` with `cappedOut: true`.

The loop core runs segments. A segment has a mask, a cap of requests, a step-name formatter, and an optional request text. `runAgent` runs the task segment, and at the cap it runs the wrap-up segment. `continueAgent` runs one segment. The segments of one run share the usage rollups, the counters, and the terminal record.

A continuation names each step `<namespace>:<name>`, for example `salvage:llm-0` or `file-metadata:llm-0`. The namespace keeps the durable cache keys of a continuation apart from the keys of its conversation.

With an accounting agent id, the continuation runs under `forSubAgent(session, id)`, thus its usage records carry that id. The loop core gives the same id to `countChatTokens`, `recordAgentRun`, and `traceAgentRun`, in place of `agent.id`. The first change makes the session key from the scope and the run frame only. Thus a continuation stays on the gateway account of its conversation.

### The wrap-up is a continuation with the mask "none"

At the iteration cap, the loop runs the wrap-up segment. Its request tells the model to answer in text, because no tool can run. Its mask is `"none"`, and its cap is 2 requests. A tool call gets the refusal, and the second request follows. When the second reply also calls a tool, the refusal results end the transcript, and the run has no final text.

The wrap-up names its request `k` `formatStepName.llm(maxIterations + k)`. The first name is the name of the old single wrap-up call. Thus a workflow that started on the earlier version replays its cached reply. The `iteration` event of request `k` carries the index `maxIterations + k`. The finish stays `max_iterations` with `cappedOut: true`, or `aborted` on an abort.

### The salvage is a continuation with a mask of the terminal tools

`runToTerminal` runs its salvage through `continueAgent`. The agent keeps its declared tools. The mask names the ids of `TerminalSalvage.tools`. The nudge is the request, and the namespace stays `salvage`. Thus the step names do not change.

`runToTerminal` throws when a terminal tool is not a declared tool of the agent, because a mask cannot let an undeclared tool run. The three callers do not change.

### An unanswered tool call gets a not-run result

At each exit, the loop answers each tool call of its own messages that has no result. It appends one `tool` message with the error result "Not run: the turn ended before this call ran." The call and its message stay. `answerUnansweredToolCalls(messages, fromIndex)` in `src/memory/tool-call-integrity.ts` replaces `stripUnansweredToolCalls`. `notRunResult(call)` gives the one result text.

The chat-turn history load (`assembleMessages`) calls the same function on the loaded window. It inserts each answer directly after the assistant message of the call and the tool messages that follow it. The answer exists only in the assembled messages, and the stored rows do not change. The answer is deterministic, thus each turn sends the same prefix. Each site logs a warn with the ids of the answered calls, as the strip did.

The comment of the strip rejects an invented result, because the model reads each result as a fact. The not-run result invents nothing. It states that the call did not run, and that statement is true. A call that the provider ran has its result in the same message, thus it gets no answer.

### The file-metadata output tool is part of the substrate

`src/tools/sandbox/submit-file-metadata.ts` holds `createSubmitFileMetadataTool(cell)` and `FileMetadataCell`, beside `report_blocker`. The cell holds the known paths and the accepted descriptions by path. The tool keeps the validation of the current `buildSubmitTool`: a match by path, the rejection of an unknown path, and the report of the remaining files.

The step body makes the cell beside `blockerHolder`. `SandboxAgentBuildContext.fileMetadata` carries the cell to `buildAgent`, and `SandboxAgentDeps.fileMetadata` carries it to `createSandboxAgent`. The substrate adds the tool as the last tool when the cell is present, the same as `report_blocker`. The data profiler gets no cell, because it runs no post-step pipeline.

The description and the input schema of the tool do not depend on the step. Thus the prefix stays byte-identical across steps. The description says that the harness asks for the tool after the task. The task runs with a mask of each declared tool except `submit_file_metadata`.

### The post-step producers continue the conversation of the step agent

The step body keeps `agent` and the transcript of the task, and it puts `agent` in `PostStepContext`. `generateStepFileMetadata` arms the cell with the paths of the manifest. Then it runs the file-metadata continuation with these values:

- the request: the describer instructions and the list of the files
- the mask: `submit_file_metadata`, `read_file`, and `grep`
- the cap: 8 requests, the current budget of the describer
- the namespace: `file-metadata`
- the accounting agent id: `file-metadata-describer`

It returns the entries and the new messages. A file with no description still gets the deterministic fallback description.

`generateStepSummaryAndWrite` runs the summary continuation over the transcript and the messages of the metadata exchange. Thus it reads the cache that the exchange wrote. The request is the summary instructions and the list of the output files. The mask lets `read_file` and `grep` run. The cap is 12 requests, the current budget of the summary writer. The namespace is `step-summary`, and the accounting agent id is `step-summary-writer`.

The summary is the final text. When the metadata stage degrades, or the manifest is empty, the summary continues the transcript directly.

Both masks let the read-only workspace tools `read_file` and `grep` run. A mask does not change the prefix, and the summary must back each number with a file. The two tools are declared tools of each step agent. Their working directory is the step directory, the same as for the `read_file` of the two forks. The system prompts of the two forks become the text of the two requests, with their rules on `read_file`.

The two stages stay inside their `DBOS.runStep` wrappers. The metadata step returns its messages with its entries. Thus a replay gives the summary the same prefix. A workflow that started on the earlier version can hold a checkpoint of the old shape, a bare array of entries. The body reads such a value as entries with no messages, and the summary then continues the transcript directly.

The body makes sure that `agent.tools` holds `submit_file_metadata` before the metadata stage. If not, it logs one warn, and it gives the fallback description to each file with no model call. An embedder whose `buildAgent` does not give the cell to the agent gets this path.

### The analogical reasoner submits its report through terminal tools

The reasoner declares two terminal tools, the same pattern as the planner with `submit_plan` and `report_blocker`. `submit_analogy_report` takes the report, `AnalogyReportSchema`, which is a top-level object. `report_blocker` comes from `createReportBlockerToolFor`, and it takes the reason of an extraction failure. Each tool records its outcome in one cell of the call. When one round records both, the report wins.

The wrapper returns the report. For a blocker, it returns the `extraction-failed` envelope with the reason as its message. The two tools and the cell are new for each call of `execute`, as the inner tools of the planner are. The tool definitions stay identical across calls, thus the prefix holds.

`runToTerminal` drives the reasoner. The terminal outcome is the cell, and the salvage mask lets only the two terminal tools run. When no outcome arrives, the wrapper returns the `extraction-failed` envelope. The prompt of the reasoner tells it to call a terminal tool, in place of a JSON reply.

The conversion call, `buildConversionPrompt`, `tryParseEnvelope`, and `stripFence` go away. The first change adds the accounting of the conversion call, and that accounting goes away with the call.

This design rejects one tool for the whole envelope. `AnalogicalReasonerOutputSchema` is a union, and `defineTool` accepts only a top-level object.

### The synthesis limits literature_reviewer to 3 calls

`generateRunSynthesis` gives `toolBudget: { literature_reviewer: 3 }`. The iteration budget of the synthesizer plans for 1 to 3 delegations, and each delegation runs a full sub-agent loop. Thus the budget makes that plan a rule of the harness. The prompt names no count, because a model takes a number in a prompt as a target. The refusal gives the limit to the model, thus the prompt does not change.

### The step body reads a blocker from the transcript

The step agent runs `report_blocker` in a durable step. A replay returns the cached result of that step and runs no `execute`, thus the blocker cell stays empty. After the loop, the body reads the blocker from the transcript: the reason of the first `report_blocker` call whose result is ok. The transcript holds each call and its result on the first run and on each replay. The cell stays the fallback for an agent whose blocker tool is not the tool of the harness.

The data profiler has the same pattern with `submit_profile`. Its loop reads the cell during the run through `resolved`, thus a read after the loop cannot fix it. This change does not fix the data profiler.

## Risks / Trade-offs

- [A model calls a tool in each wrap-up request] → The run ends with no final text. The literature reviewer already gives an error for an empty report. The terminal record of the run is a warn, thus an operator sees the count.
- [A model calls a masked tool during a task] → One refusal costs one round. The description of `submit_file_metadata` says when the harness asks for it.
- [The summary uses each of its 12 requests on reads] → The step gets no summary, because a continuation has no wrap-up at its cap. `incrementSummaryNullCount` records the empty result. The cap is the budget of the current writer, which has room for some reads and the write-up.
- [An embedder does not give the metadata cell to the agent] → The step logs a warn, and it uses the fallback descriptions. The CLI gives the cell in this change. Cortex gives it when it bumps the pin.
- [A continuation starts after the cache lifetime of 5 minutes] → The request writes the prefix again, as each fork does now. The cache lifetime of each role is a later change.
- [A not-run result shows in the display of a thread] → The display shows the call as an error. Before, the call disappeared from the stored thread.
- [The deltas build on a change that is not archived] → The `harness-agent-loop` delta and the `llm-usage-accounting` delta use the text of the first change. Archive the first change before this change.

## Migration Plan

No data migration is necessary. A stored thread keeps its rows, and the history load answers an old unanswered call when it reads the window. A host that takes this version gives the metadata cell in its `buildAgent`.

A workflow that started on the earlier version replays its cached steps in these cases:

- The first wrap-up request keeps its old step name. Thus it replays the reply of the earlier single wrap-up call.
- The body reads an old metadata checkpoint as entries with no messages.
- A refused call of a step-mode tool takes the step that the earlier build recorded for the call as an unknown tool.

A workflow that started on the earlier version does not replay in these cases:

- The stored wrap-up reply calls a tool, because the endpoint ignored the tool choice `none`. The wrap-up then sends a second request that the recording does not hold.
- A durable salvage of the earlier build called a workflow-mode or an inline-mode tool, for example `execute_command` in the salvage of the data profiler. The earlier build ran that call in a step, and the refusal runs no step.
- A durable salvage of the earlier build used its cap, thus it sent one more wrap-up request. The salvage continuation sends no wrap-up request.

The data profiler is the only caller of `runToTerminal` with durable steps. The other callers use `passthroughStep`, thus a salvage of theirs has no replay.

A delta cannot change the Purpose of a spec. The Purpose sections of `harness-agent-loop`, `harness-sandbox-agents`, and `step-interpretation-summary` describe the forks and the salvage with only the terminal tools. Write those sections again when this change archives.

## Open Questions

None.
