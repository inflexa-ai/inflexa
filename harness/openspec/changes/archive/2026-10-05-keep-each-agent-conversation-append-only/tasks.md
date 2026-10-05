# Tasks

Each path is relative to `harness/`. A path that starts with `cli/` is relative to the root of the repository.

This change builds on `update-the-provider-layer-for-current-models`. Start group 1 when the branch holds the code of that change: `accountForChatCall`, the effort on the provider configuration, and the metrics of each call.

A database test uses Postgres. Give it `CORTEX_TEST_PG_URL`, or run it with `bun run test:full`, as the Testing section of `CLAUDE.md` describes.

## 1. The tool mask and the tool budget

- [x] 1.1 Add `src/loop/tool-mask.ts`. Export `type ToolMask = "none" | { readonly allow: readonly string[] }` and `type ToolBudget = Readonly<Record<string, number>>`. The module header says that a request always declares the full tool set.
- [x] 1.2 In `src/loop/tool-mask.ts`, export `refusalsFor(calls, mask, budget, used): (string | undefined)[]`. For each call in call order, it gives `undefined` when the call passes, or the text of the refusal.
- [x] 1.3 In `refusalsFor`, a call passes when the mask names its tool and `used` is below the budget of the tool. Add 1 to `used` for each call that passes, whatever its later result.
- [x] 1.4 Give each refusal as the JSON text `{ error, retryable: false }`, the shape that `toolErrorContent` gives. The mask refusal names the tool. The budget refusal names the tool and the limit.
- [x] 1.5 In the same file, export `maskExcept(tools: readonly Tool[], ids: readonly string[]): ToolMask`. It gives a mask of each tool id except `ids`.
- [x] 1.6 In `src/loop/run-agent.ts`, add `readonly toolMask?: ToolMask` and `readonly toolBudget?: ToolBudget` to `RunAgentOptions`, each with a doc comment. Without a mask, each declared tool can run.
- [x] 1.7 In `runAgentLoop`, keep one `used` map for each run. On both dispatch paths, call `refusalsFor` on the calls of the round before `dispatchTools`.
- [x] 1.8 Give each refused call `errorResult(tu, refusal)` at its index, inside the step wrapper that a dispatched call of its tool id gets. Run the tool of each call that passes. Expected result: a refused call runs no tool, the step sequence of the round does not change, and the results keep the order of the calls.
- [x] 1.9 Keep the `tool-started` event of each call before the dispatch. Give the refused results to `settleRound` with the dispatched results. Expected result: each refused call gets `tool-finished` with the outcome `error`, and it counts as a tool error.
- [x] 1.10 In `src/loop/run-agent.test.ts`, add `describe("runAgent — tool mask and budget")` with these tests:
  - A call outside the mask does not run, and its result names the mask.
  - The budget refuses the fourth call of a tool.
  - The budget counts the earlier calls of the same round.
  - A refused step-mode call records the step name of its tool, and a replay of the step of an earlier build succeeds.
  - The round of a truncation applies the mask to its earlier calls.
  - A run with no mask dispatches each call as before.
- [x] 1.11 Run `tsc -p tsconfig.json`. Run `bun test src/loop/run-agent.test.ts`. Run `bun run lint`. Run `bun run format:file src/loop/tool-mask.ts src/loop/run-agent.ts src/loop/run-agent.test.ts`.

## 2. The answer to an unanswered tool call

- [x] 2.1 In `src/memory/tool-call-integrity.ts`, export `NOT_RUN_TOOL_RESULT = "Not run: the turn ended before this call ran."`. Export `notRunResult(call: ToolCallPart): ToolResultPart`, with the output `{ type: "error-text", value: NOT_RUN_TOOL_RESULT }`.
- [x] 2.2 Replace `stripUnansweredToolCalls` with `answerUnansweredToolCalls(messages: ModelMessage[], fromIndex = 0): AnsweredToolCall[]`. Rename `DroppedToolCall` to `AnsweredToolCall`.
- [x] 2.3 In `answerUnansweredToolCalls`, find each assistant message at or after `fromIndex` whose calls have no result. Insert one `tool` message with `notRunResult` for each such call.
- [x] 2.4 Insert that `tool` message after the assistant message and after the `tool` messages that follow it. Expected result: the function removes no message and changes no message.
- [x] 2.5 Keep `needsClientResult`, thus a call that the provider ran gets no answer. Write the module header again: the repair is a result that states that the call did not run.
- [x] 2.6 In `src/loop/run-agent.ts`, make `settleTranscript` call `answerUnansweredToolCalls(messages, initial.length)`. Change the warn message to `"unanswered tool calls answered at run exit"`, and keep its fields. Write the doc comment again.
- [x] 2.7 In `src/loop/run-agent.ts`, keep the interruption marker on the last assistant message of the run on each abort path. Remove each comment that says that the settle can remove a message.
- [x] 2.8 In `src/app/message-assembly.ts`, call `answerUnansweredToolCalls(history)` in place of the strip. Change the warn message to `"unanswered tool calls answered in thread history"`, and keep its fields. Write the comment again.
- [x] 2.9 In `src/memory/tool-call-integrity.test.ts`, change each strip test into an answer test. Expected result: the call and the prose stay, and the not-run result comes after the assistant message and its tool messages.
- [x] 2.10 In `src/loop/run-agent.test.ts`, change `describe("runAgent — undispatched tool calls at a terminal finish")` and the abort tests. Expected result: a `content-filter` call stays with a not-run result, and its tool never runs.
- [x] 2.11 In the same file, add a test for an aborted partial with a complete call. Expected result: the partial stays with the interruption marker, and a not-run result follows it.
- [x] 2.12 In `src/app/message-assembly.test.ts`, change `"repairs a stored dangling tool call and logs the strip"`. Expected result: the not-run result sits between the assistant message and the next user message.
- [x] 2.13 In the same file, add a test that two assemblies of one window give byte-identical messages.
- [x] 2.14 Run `tsc -p tsconfig.json`. Run `bun test src/memory/tool-call-integrity.test.ts src/loop/run-agent.test.ts src/app/message-assembly.test.ts`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 3. The continuation

- [x] 3.1 In `src/loop/run-agent.ts`, move the request and dispatch loop of `runAgentLoop` into a segment function. A segment takes a mask, a cap of requests, a step-name formatter, and an optional request text.
- [x] 3.2 Keep the run state outside the segment: the messages, the usage rollups, the counters, the `used` map of the budget, and the logger. Expected result: `runAgent` runs one task segment, and each test of `src/loop` passes.
- [x] 3.3 Export the segment function for `src/loop/continue-agent.ts` only. Do not add it to `src/index.ts`.
- [x] 3.4 Add `src/loop/continue-agent.ts`. Export `ContinuationRequest` with `text`, `mask`, `maxRequests`, `stepNamespace`, and an optional `accountingAgentId`. Export `ContinuationResult` with `messages` and `finish`.
- [x] 3.5 Export `continueAgent(agent, conversation, request, session, opts: RunAgentOptions): Promise<ContinuationResult>`. It appends `syntheticUserMessage(request.text)` and runs one segment with no wrap-up.
- [x] 3.6 Make `continueAgent` return the messages from the request to the end. Expected result: the messages of `conversation` stay unchanged.
- [x] 3.7 In `continueAgent`, name each step `${request.stepNamespace}:${name}`. `name` comes from `opts.formatStepName ?? DEFAULT_STEP_NAME_FORMATTER`. Expected result: the first model step of the namespace `file-metadata` is `file-metadata:llm-0`.
- [x] 3.8 With `accountingAgentId`, run the segment under `forSubAgent(session, accountingAgentId)`. Give that id to `countChatTokens`, `recordAgentRun`, and `traceAgentRun` in place of `agent.id`. Expected result: the usage records, the token counters, and the iteration histogram carry the accounting id.
- [x] 3.9 At its cap, make `continueAgent` return `finish.reason: "max_iterations"` with `cappedOut: true`, with no wrap-up request. On an abort, it returns `"aborted"`.
- [x] 3.10 In the doc comment of `CALL_PATH_DELIMITER` in `src/loop/run-agent.ts`, add the namespaces of the continuations to the list of step names.
- [x] 3.11 In `src/loop/run-agent.test.ts`, add `describe("continueAgent")` with these tests:
  - The first request holds the system prompt, the tools, and each message of the conversation, byte-identical.
  - The result holds only the synthetic request and the new messages.
  - The cap ends the continuation with no wrap-up request.
  - The usage record carries the accounting agent id, and the `runId` and the `stepId` of the session.
  - The step names carry the namespace.
- [x] 3.12 Run `tsc -p tsconfig.json`. Run `bun test src/loop`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 4. The wrap-up as a continuation

- [x] 4.1 In `src/loop/run-agent.ts`, add `WRAP_UP_REQUEST` and `WRAP_UP_MAX_REQUESTS = 2`. The request says that the run reached its iteration limit, that no tool can run, and that the model must answer in text.
- [x] 4.2 Replace the single wrap-up call with the wrap-up segment: the request `WRAP_UP_REQUEST`, the mask `"none"`, and the cap `WRAP_UP_MAX_REQUESTS`.
- [x] 4.3 Name wrap-up request `k` `formatStepName.llm(agent.maxIterations + k)`. Expected result: each request sends `tools: toolDefs` and the `toolChoice` of `opts`, and no request sends `toolChoice: "none"`.
- [x] 4.4 Keep the finish of a capped run: `max_iterations` with `cappedOut: true`, or `aborted` with `cappedOut: true`. Keep the terminal record at `warn`.
- [x] 4.5 Emit the `iteration` event of wrap-up request `k` with `index: agent.maxIterations + k`. Set `final: true` on the last request.
- [x] 4.6 Write the doc comment of `RunAgentOptions.toolChoice` in `src/loop/run-agent.ts` again. Also write `AgentDefinition.maxIterations` and the `index` of the `iteration` event in `src/loop/types.ts` again.
- [x] 4.7 Each comment of 4.6 says that the wrap-up keeps the tools and the tool choice, and that a mask refuses each call.
- [x] 4.8 In `src/providers/types.ts`, add a CAUTION to the doc comment of `ChatRequest.toolChoice`. `@ai-sdk/anthropic` removes the tools for `"none"`, and Anthropic drops its message cache when `tool_choice` changes.
- [x] 4.9 In the header of `src/providers/prompt-cache.ts`, remove the wrap-up from the list of the section "Cache defeaters". State that the wrap-up keeps the tool set and the tool choice, and that a mask refuses each call.
- [x] 4.10 In `src/loop/run-agent.test.ts`, change `describe("runAgent — max-iteration wrap-up")`, `describe("runAgent — aborted wrap-up path")`, and `describe("runAgent — finish signal")`. Add these tests:
  - The wrap-up sends the tools and the `toolChoice` of the run.
  - A text reply ends the wrap-up after one request, under the step name `llm-${maxIterations}`.
  - A refused call gets a second request.
  - The wrap-up ends after 2 requests.
- [x] 4.11 In `src/loop/prompt-cache.test.ts`, change `"marks the last message on every iteration, the wrap-up included"` and `"counts the wrap-up call's tokens too"`. Expected result: each wrap-up request has one message breakpoint and no `toolChoice`.
- [x] 4.12 Change each other test in `src/loop` that counts the calls of a capped run. A provider that always calls a tool now gets 2 wrap-up requests.
- [x] 4.13 Run `tsc -p tsconfig.json`. Run `bun test src/loop`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 5. The salvage as a continuation

- [x] 5.1 In `src/loop/run-to-terminal.ts`, run the salvage through `continueAgent` with `first.messages` and `opts`. Give the request `{ text: salvage.nudge, mask: { allow: salvage.tools.map((t) => t.id) }, maxRequests: salvageBudget, stepNamespace: "salvage" }`.
- [x] 5.2 Remove `salvageAgent` and `salvageStepNames`. Return `[...first.messages, ...salvaged.messages]` as the messages of the result.
- [x] 5.3 Keep `sumUsage`, the `SalvageRecord`, and the warn record. Expected result: the step names stay `salvage:llm-0` and `salvage:tool-<name>-<id>`.
- [x] 5.4 Throw at the start of `runToTerminal` when a tool of `salvage.tools` is not in `agent.tools`. The message names the tool and the agent.
- [x] 5.5 Write the module header and the doc comments of `TerminalSalvage` again. The salvage keeps the declared tools, and the ids of `salvage.tools` make the mask. Remove the salvage run from the list of cache defeaters in `src/providers/prompt-cache.ts`.
- [x] 5.6 In `src/loop/run-to-terminal.test.ts`, add these tests:
  - Each salvage request declares each tool of the agent.
  - A salvage call of a tool that is not terminal gets the error result of the mask.
  - An undeclared terminal tool throws.
- [x] 5.7 Make sure that the salvage tests in `src/execution/run-synthesis.test.ts` and `src/tools/research/generate-plan.test.ts` pass. Change a test only when it asserts the tool set of a salvage request.
- [x] 5.8 Run `tsc -p tsconfig.json`. Run `bun test src/loop/run-to-terminal.test.ts src/execution/run-synthesis.test.ts`.
- [x] 5.9 Run `bun test src/tools/research/generate-plan.test.ts` with Postgres. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 6. The budget of the synthesis

- [x] 6.1 In `src/execution/run-synthesis.ts`, add `LITERATURE_REVIEWER_BUDGET = 3`. Give `toolBudget: { [reviewer.id]: LITERATURE_REVIEWER_BUDGET }` to `loopDeps`.
- [x] 6.2 The comment of the constant names the 1 to 3 delegations for each run that the iteration budget of the synthesizer plans for. Do not change `src/prompts/synthesis-agent.ts`, because it names no count.
- [x] 6.3 In `src/execution/run-synthesis.test.ts`, add a test in which the synthesizer calls `literature_reviewer` 4 times. Expected result: 3 reviewer loops run, and the fourth call gets the error result of the budget.
- [x] 6.4 Run `tsc -p tsconfig.json`. Run `bun test src/execution/run-synthesis.test.ts`. Run `bun run lint`. Run `bun run format:file src/execution/run-synthesis.ts src/execution/run-synthesis.test.ts`.

## 7. The file-metadata output tool

- [x] 7.1 Add `src/tools/sandbox/submit-file-metadata.ts`. Export `SUBMIT_FILE_METADATA_TOOL_ID = "submit_file_metadata"`, `FileMetadataCell`, `createFileMetadataCell()`, and `createSubmitFileMetadataTool(cell)`.
- [x] 7.2 `FileMetadataCell` holds the known paths, set by `expect(paths)`, and the accepted descriptions by path.
- [x] 7.3 Move the validation of `buildSubmitTool` from `src/execution/artifact-metadata.ts` into the tool. Keep the match by path, the rejection of an unknown path, and the report of the remaining files.
- [x] 7.4 The `description` of the tool does not depend on the step. It says that the harness asks for the tool after the task. A call before `expect` gives a `ToolError`.
- [x] 7.5 In `src/agents/sandbox/shared.ts`, add `readonly fileMetadata?: FileMetadataCell` to `SandboxAgentDeps`. When the cell is present, add `createSubmitFileMetadataTool(deps.fileMetadata)` as the last tool.
- [x] 7.6 In the same file, write the module header and the doc comment of the field. The data profiler gets no cell, because it runs no post-step pipeline.
- [x] 7.7 In `src/workflows/sandbox-step.ts`, add `readonly fileMetadata: FileMetadataCell` to `SandboxAgentBuildContext`. Make the cell beside `blockerHolder`, and give it to `deps.buildAgent`.
- [x] 7.8 In the same file, run the task with `toolMask: maskExcept(agent.tools, [SUBMIT_FILE_METADATA_TOOL_ID])`. Expected result: a call of `submit_file_metadata` during the task gets the error result of the mask.
- [x] 7.9 In `cli/src/modules/harness/run_deps.ts`, give `fileMetadata: ctx.fileMetadata` to the `SandboxAgentDeps` of `buildStepAgent`. In `cli/src/modules/harness/run_deps.test.ts`, add the field to the build context of the test.
- [x] 7.10 In `src/agents/sandbox/shared.test.ts`, add these tests:
  - A cell adds `submit_file_metadata` as the last tool.
  - An agent with no cell has no such tool.
  - The system prompt is byte-identical with and without the cell.
- [x] 7.11 In `src/workflows/sandbox-step.test.ts`, give the output tool to the agent of each test rig through `fileMetadata`. Add a test that the task masks `submit_file_metadata`.
- [x] 7.12 Run `tsc -p tsconfig.json`. Run `bun test src/agents/sandbox/shared.test.ts src/workflows/sandbox-step.test.ts`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.
- [x] 7.13 In `cli/`, run `bun run harness:local`, `bun run typecheck`, `bun run lint`, and `bun test src/modules/harness/run_deps.test.ts`. Then run `bun run format:file src/modules/harness/run_deps.ts src/modules/harness/run_deps.test.ts`.

## 8. The post-step continuations

- [x] 8.1 In `src/workflows/sandbox-step.ts`, add `readonly agent: AgentDefinition` and `readonly fileMetadata: FileMetadataCell` to `PostStepContext`. Give the built agent and the cell to `postCtx`.
- [x] 8.2 In `src/execution/artifact-metadata.ts`, change `GenerateFileMetadataOptions`. Add `agent`, `cell`, and the transcript. Remove `workspaceFs`, `workingDir`, and `maxIterations`.
- [x] 8.3 In `generateFileMetadata`, set the known paths with `cell.expect(displayPaths)`. Then run `continueAgent` with these values:
  - the request: the text of `describerRequest(artifacts)`
  - the mask: `{ allow: [SUBMIT_FILE_METADATA_TOOL_ID, "read_file", "grep"] }`
  - `maxRequests: 8`
  - `stepNamespace: "file-metadata"`
  - `accountingAgentId: "file-metadata-describer"`
- [x] 8.4 Make `describerRequest` from the current `SYSTEM_PROMPT` and `buildPrompt`, with their rules on `read_file`. The mask lets the declared `read_file` and `grep` of the agent run.
- [x] 8.5 Return `{ indexed, entries, messages }`, where `messages` holds the new messages of the continuation. Keep the fallback entries and the fallback warn.
- [x] 8.6 Remove `sanitizeTranscript`, `buildSubmitTool`, and the describer `AgentDefinition` from `src/execution/artifact-metadata.ts`.
- [x] 8.7 When `agent.tools` has no `submit_file_metadata`, log one warn and return the fallback entries with no model call. Expected result: an embedder that does not give the cell gets fallback descriptions, not an error.
- [x] 8.8 In `src/execution/step-summary.ts`, change `generateStepSummary` to take `agent` and a conversation: the transcript plus the metadata messages.
- [x] 8.9 Run `continueAgent` with the request `summaryRequest(artifactPaths)`, the mask `{ allow: ["read_file", "grep"] }`, and `maxRequests: 12`. Use `stepNamespace: "step-summary"` and `accountingAgentId: "step-summary-writer"`.
- [x] 8.10 Read the markdown with `finalText` on the new messages. Keep `incrementSummaryNullCount` for an empty text and for a throw.
- [x] 8.11 Remove `sanitizeTranscript`, the writer `AgentDefinition`, and the options `workspaceFs`, `workingDir`, and `maxIterations` from `src/execution/step-summary.ts`. Remove the two post-step forks from the list of cache defeaters in `src/providers/prompt-cache.ts`.
- [x] 8.12 Keep `stepSummaryPrompt` in `src/prompts/execute-analysis/step-summary.ts` with no change. Its rules on `read_file` stay, because the mask lets `read_file` run.
- [x] 8.13 Make `summaryRequest` from the current `SYSTEM_PROMPT` of `src/execution/step-summary.ts` and `stepSummaryPrompt`, with no change of their text.
- [x] 8.14 In `src/execution/post-step-pipeline.ts`, make `generateStepFileMetadata` return `{ entries, messages }`. Give `postCtx.agent`, `postCtx.fileMetadata`, `deps.provider`, and `deps.usageRecorder` to the producer. Remove `workspaceFs` from `PostStepPipelineDeps`, because no stage reads it. Keep `SandboxStepDeps.workspaceFs`, and tell the user that it has no reader.
- [x] 8.15 Make `generateStepSummaryAndWrite` take the metadata messages, and give them to `generateStepSummary`.
- [x] 8.16 In `src/workflows/sandbox-step.ts`, give the metadata messages of the metadata step to the summary step. Expected result: a replay gives the summary the same prefix.
- [x] 8.17 In the same file, read a cached metadata value that is a bare array as entries with no messages. Expected result: a checkpoint of the earlier version still replays.
- [x] 8.18 In `src/execution/artifact-metadata.test.ts`, change the tests to run a continuation. Keep the tests of the match by path, the unknown path, the fallback, `extraMetadata`, and the read of a file.
- [x] 8.19 In the same file, add a test that an agent with no output tool gets the fallback with no provider call.
- [x] 8.20 In `src/execution/step-summary.test.ts`, change the tests to run a continuation. Remove the sanitize test. Keep the test that grounds the summary in a file that `read_file` reads.
- [x] 8.21 In the same file, add a test that the request declares the tools of the agent. Its messages start with the transcript and the metadata messages, byte-identical.
- [x] 8.22 In the same file, add a test in which the model calls `write_file`. Expected result: the call gets the error result of the mask, and no file changes.
- [x] 8.23 In `src/workflows/sandbox-step.test.ts`, add a test that the summary request holds the messages of the metadata exchange. Add a test that a cached metadata array replays as entries.
- [x] 8.24 Run `tsc -p tsconfig.json`. Run `bun test src/execution/artifact-metadata.test.ts src/execution/step-summary.test.ts src/workflows/sandbox-step.test.ts`.
- [x] 8.25 Run `bun test src/execution/post-step-pipeline.test.ts` with Postgres. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 9. The terminal tools of the analogy report

- [x] 9.1 In `src/tools/research/generate-analogy-report.ts`, add `submit_analogy_report` with the input `AnalogyReportSchema`, a top-level object. The tool records `{ kind: "report", report }` in the outcome cell of the call, and it tells the agent to stop.
- [x] 9.2 Add `report_blocker` through `createReportBlockerToolFor`. Its `blockedWhen` says that the problem is empty or incoherent, thus phase 1 cannot extract its objects and relations.
- [x] 9.3 The `record` of `report_blocker` writes `{ kind: "blocker", reason }` into the same cell, and it does not replace a report. A report replaces a blocker. Expected result: when one round records both, the report wins.
- [x] 9.4 Build the two tools, the cell, and the reasoner `AgentDefinition` in each call of `execute`. Put the two terminal tools after the search tools. Expected result: the tool definitions and their order are identical across calls.
- [x] 9.5 Run the reasoner through `runToTerminal`, with `resolved: () => cell.outcome !== null`. Give the salvage `{ tools: [submitReportTool, blockerTool], nudge: ANALOGY_SALVAGE_NUDGE }`.
- [x] 9.6 Return the recorded report. For a blocker, return the `extraction-failed` envelope with the reason as its message. With no outcome, return `buildExtractionFailedEnvelope()`. Keep the envelope of a loop throw.
- [x] 9.7 Remove the conversion call with its `countChatTokens` and its `accountForChatCall`, and remove `CONVERSION_CALL_NAME`. Remove `buildConversionPrompt`, `tryParseEnvelope`, `stripFence`, `ParseSuccess`, and `ParseFailure`. Write the module header again.
- [x] 9.8 Keep `deps.logger`, and give it to `runToTerminal`, thus the warn of a salvage reaches the log. Write the doc comment of the field again.
- [x] 9.9 In `src/prompts/analogical-reasoner.ts`, write the output section again. The reasoner calls `submit_analogy_report` one time with the report. When phase 1 cannot run, it calls `report_blocker` with a one-line reason.
- [x] 9.10 In the same prompt, keep the shape of the report and the coverage rules. Remove the error JSON, and the text on the post-processor and on `JSON.parse()`.
- [x] 9.11 In the header of `src/tools/sandbox/report-blocker.ts`, name the analogical reasoner as the fourth loop that offers the tool.
- [x] 9.12 In the `description` of `generate_analogy_report`, write the sentence on the internal retry again: the wrapper salvages a run one time. Keep the text on the `extraction-failed` error.
- [x] 9.13 In `src/tools/research/generate-analogy-report.test.ts`, remove the tests of the conversion and of `tryParseEnvelope`. Add these tests:
  - A submitted report is the result, and the provider gets no call after the submit.
  - A blocker gives the `extraction-failed` envelope with its reason as the message.
  - A run that ends on prose gets a salvage whose mask lets only the two terminal tools run.
  - No outcome after the salvage gives the `extraction-failed` envelope.
  - An invalid report gets an input validation error, and a second submit is accepted.
- [x] 9.14 Run `tsc -p tsconfig.json`. Run `bun test src/tools/research/generate-analogy-report.test.ts`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 10. Documents

- [x] 10.1 In `CONTEXT.md`, section "Loop primitives", write the item "The loop" again. The wrap-up is a continuation with the mask `"none"`, and the loop answers each unanswered call.
- [x] 10.2 In the same section, add one item for the tool mask and the tool budget, and one item for `continueAgent`.
- [x] 10.3 In `CONTEXT.md`, section "Post-step pipeline", write the paragraph "File metadata is lossless" again. The file metadata and the summary are continuations of the conversation of the step agent.
- [x] 10.4 Write each changed sentence in STE. Run `bun ../.claude/hooks/ste-check.ts --file CONTEXT.md`, and fix each hard finding in the changed text.
- [x] 10.5 This group changes no file under `src/`, thus it has no build step. Do not format a markdown file, as `CLAUDE.md` states.

## 11. Final checks

- [x] 11.1 Run `tsc -p tsconfig.json`. Expected result: no error.
- [x] 11.2 Run `bun test`. Expected result: each unit test passes. A database suite uses Postgres.
- [x] 11.3 Run `bun run lint`. Expected result: no error.
- [x] 11.4 Run `grep -rn "stripUnansweredToolCalls\|sanitizeTranscript\|tryParseEnvelope" src`. Expected result: no match.
- [x] 11.5 Make sure that no request in `src/` sets `toolChoice: "none"`. Only the CAUTION comment of `ChatRequest.toolChoice` names the value.
- [x] 11.6 In `cli/`, run `bun run harness:local`, `bun run typecheck`, `bun run lint`, and `bun test src/modules/harness`.
