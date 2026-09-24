# Tasks

Each path is relative to `harness/`. A path that starts with `cli/` or `images/` is relative to the root of the repository.

This change builds on `keep-each-agent-conversation-append-only` and `save-each-chat-round-and-add-context-on-change`. Start group 1 when the branch holds the code of both changes. That code holds the tool mask, `continueAgent`, the two post-step continuations, the round sink, and `runChatTurn`.

A database test uses Postgres. Give it `CORTEX_TEST_PG_URL`, or run it with `bun run test:full`, as the Testing section of `CLAUDE.md` describes.

## 1. The cut and the store interface in the loop

- [x] 1.1 Add `src/loop/tool-output.ts`. Export `TOOL_RESULT_CAP = 32 * 1024`, `EXCERPT_HEAD_CHARS = 4 * 1024`, and `EXCERPT_TAIL_CHARS = 8 * 1024`.
- [x] 1.2 In the same file, export `TOOL_OUTPUT_KEEP_MAX = 1024 * 1024` and `READ_TOOL_OUTPUT_TOOL_ID = "read_tool_output"`. The doc comment of each value gives its reason.
- [x] 1.3 Export the interfaces `KeptToolOutput` and `ToolOutputStore` of the design. The error type of `put` and `get` is `DomainError` of `src/lib/result.ts`.
- [x] 1.4 Export `toolOutputRef(key: string): string`. It gives `to_` and the first 20 hexadecimal characters of the SHA-256 hash of the key.
- [x] 1.5 Export `resultTextOf(output: ToolResultPart["output"]): string | undefined`. It gives the text of the design for each output type, and `undefined` for `execution-denied`.
- [x] 1.6 Export `keptTextOf(text: string): string`. A text of at most `TOOL_OUTPUT_KEEP_MAX` characters comes back whole.
- [x] 1.7 For a longer text, `keptTextOf` gives the first half and the last half of the maximum. A marker line between them gives the count of the dropped characters.
- [x] 1.8 Export `excerptOf(text: string, kept: { ref: string; keptLength: number } | undefined): string`. It gives the lines, the start, the marker line, and the end of the design.
- [x] 1.9 In `excerptOf` and `keptTextOf`, move a cut point by one unit when it splits a surrogate pair.
- [x] 1.10 Export `withExcerpt(part: ToolResultPart, excerpt: string): ToolResultPart`. It gives the output types of the design, and it keeps the file parts of a `content` result.
- [x] 1.11 In `src/loop/run-agent.ts`, add `readonly toolOutputStore?: ToolOutputStore` to `RunAgentOptions`. The doc comment says that a run with no store cuts and keeps nothing.
- [x] 1.12 In `openLoop`, make one cut context for the run: the store, the session, `opts.invocationId`, the logger, and `toolsById.has(READ_TOOL_OUTPUT_TOOL_ID)`.
- [x] 1.13 Give the cut context and the tool step name of each call to `dispatchTool`, through `dispatchTools`.
- [x] 1.14 In `dispatchTool`, give each result to a new function `cutLongResult` before the return. Expected result: each branch of `dispatchTool` returns through that one function.
- [x] 1.15 In `cutLongResult`, give back the result with no change when its text is `undefined` or at most `TOOL_RESULT_CAP` characters.
- [x] 1.16 For a longer text, keep the text only when the run has a store and the agent declares `read_tool_output`.
- [x] 1.17 To keep the text, make the key with `recordKeyFor(session, invocationId, stepName)`, and the reference with `toolOutputRef(key)`.
- [x] 1.18 Await `store.put` with the analysis id of the session, the reference, the tool name, and the tool call id. The text is `keptTextOf(text)`, and the length is `text.length`.
- [x] 1.19 Give `threadId: session.scope.threadId` only when `session.runFrame` is absent. Expected result: a text of a run names no thread.
- [x] 1.20 Read the `put` result with no `try`. On `err`, log the warn `"tool output not kept"` with `toolName`, `toolCallId`, `ref`, and the error type.
- [x] 1.21 Give back `withExcerpt(part, excerptOf(text, kept))`. Expected result: the excerpt is the same when the `put` gives `err`.
- [x] 1.22 Write the doc comment of `recordKeyFor` again. It keys a usage record and a kept tool output, and its scheme does not change.
- [x] 1.23 In the new file `src/loop/tool-output.test.ts`, add `describe("runAgent — long tool results")` with a fake store. Add these tests:
  - A result of exactly 32,768 characters stays a `json` result with no change.
  - A result of 32,769 characters becomes a `text` excerpt with the first line, the start, the marker line, and the end.
  - A thrown error of 50,000 characters becomes an `error-text` excerpt, and `tool-finished` reports `error`.
  - A result with a picture keeps its file part after the excerpt.
  - The store gets the analysis id, a reference that matches `/^to_[0-9a-f]{20}$/`, the whole text, and the length.
  - A chat session gives its thread id. A run session gives none, also with a thread id in its scope.
  - The fake provider reads the store at the second request, and the record is there.
  - A run with no store gives the line `The rest is not kept.` and no second line.
  - An agent with no `read_tool_output` gives the same text, and the store gets no `put`.
  - A `put` that gives `err` gives the same excerpt as a working store, and one warn.
  - Two runs of one script under one run frame give the same reference.
  - A step-mode tool under a recording `runStep` gives the excerpt as the output of its step.
  - The round of a truncation cuts a long result of an earlier call of that round.
  - A continuation cuts a long result with the store of its options.
  - A text of 3,000,000 characters gives a kept text with both halves and the marker line.
  - A surrogate pair at a cut point stays whole.
- [x] 1.24 Run `tsc -p tsconfig.json`. Run `bun test src/loop`. Run `bun run lint`. Run `bun run format:file src/loop/tool-output.ts src/loop/run-agent.ts src/loop/tool-output.test.ts`.

## 2. The table and the Postgres store

- [x] 2.1 In `src/state/init.ts`, add the table `cortex_tool_outputs` and the partial index `cortex_tool_outputs_thread_idx` of the design, after the table `messages`.
- [x] 2.2 Write a comment block for the columns, with no semicolon, because the init divides the DDL at each semicolon.
- [x] 2.3 In that block, say that `thread_id` is null for a text of a run. Say which purge removes which rows.
- [x] 2.4 Add `src/state/tool-outputs.ts`. Export `createToolOutputStore(pool: Pool): ToolOutputStore`.
- [x] 2.5 Make `put` one `INSERT ... ON CONFLICT (analysis_id, ref) DO UPDATE` through `tryMutation`, with the op `toolOutputs.put`.
- [x] 2.6 The insert writes `thread_id`, or null when the record has no thread id. The update keeps `created_at`.
- [x] 2.7 Make `get` one `SELECT` by `analysis_id` and `ref` through `tryQuery`, with the op `toolOutputs.get`. No row gives `null`.
- [x] 2.8 In `src/state/purge-analysis.ts`, add the delete of `cortex_tool_outputs` by `analysis_id` to the list of the analysis-keyed deletes. A comment at the entry gives the reason for the key.
- [x] 2.9 In `src/memory/thread-store.ts`, make `purgeThread` delete the rows of `cortex_tool_outputs` whose `thread_id` is in `SUBTREE_CTE`.
- [x] 2.10 Run that delete in the transaction of the purge, before the delete of the thread rows. Add the kept tool outputs to the module header.
- [x] 2.11 Add `src/state/tool-outputs.test.ts` with `withSchema`. Add these tests:
  - A text of 300,000 characters with a character outside ASCII round-trips byte-identical.
  - A record with a thread id round-trips it, and a record with no thread id reads back with none.
  - A second `put` of one key replaces the text and keeps `created_at`.
  - A `get` with a different analysis id gives `null`.
  - A `get` of an unknown reference gives `null`.
- [x] 2.12 In `src/state/purge-analysis.test.ts`, add a test. Expected result: the purge removes the rows of the analysis, and the row of a second analysis stays. Add the table to the pinned list of the analysis-keyed tables, and seed two rows.
- [x] 2.13 In `src/memory/thread-store.test.ts`, add a test with a thread, its child, and a text of a run. Expected result: the purge removes the texts of both threads.
- [x] 2.14 In the same test, expect that the text of the run stays. Add the kept tool outputs to the test of the failed subtree delete.
- [x] 2.15 Run `tsc -p tsconfig.json`. Run `bun test src/state/tool-outputs.test.ts src/state/purge-analysis.test.ts src/memory/thread-store.test.ts` with Postgres.
- [x] 2.16 Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 3. The tool read_tool_output

- [x] 3.1 Add `src/tools/read-tool-output.ts`. Export `createReadToolOutputTool(store: ToolOutputStore): Tool` with the id `READ_TOOL_OUTPUT_TOOL_ID`, in the default `step` mode.
- [x] 3.2 Give the input schema the field `ref`, and the optional fields `offset` (an integer from 0), `limit` (an integer from 1 to 16,384), and `pattern`.
- [x] 3.3 Write the description. It names the excerpt and its reference, and the unit and the start of an offset. It also names the page maximum and the pattern.
- [x] 3.4 Add `describeCall`. It gives the reference alone, or `${pattern} in ${ref}` for a search.
- [x] 3.5 In `execute`, read `store.get(ctx.session.scope.analysisId, ref)` through `unwrapOrThrow`. A `null` gives `{ status: "not_found", ref }`.
- [x] 3.6 An offset at or past the end of the kept text gives `out_of_range`. A read with no pattern gives the window, with a default limit of 8,192.
- [x] 3.7 With a pattern, compile it with the flag `g`. A compile failure gives `invalid_pattern` with the message of the error.
- [x] 3.8 Search the window to `offset + limit`, or to the end of the kept text when the call gives no limit. Stop after 20 matches.
- [x] 3.9 Give each match its offset and the text from 150 characters before it to 250 characters after its start.
- [x] 3.10 After a match of zero length, move `lastIndex` on by one character.
- [x] 3.11 Give `end` and `more` on a page and on a search. Move each edge of a window by one unit to keep a surrogate pair whole.
- [x] 3.12 Measure `JSON.stringify` of the result. Until it has at most `TOOL_RESULT_CAP - 512` characters, shorten the text by a quarter, or drop the last match.
- [x] 3.13 Add `src/tools/read-tool-output.test.ts` with a fake store. Add these tests:
  - A page of 8,192 characters from the offset 4,096 gives the text, the end, and the kept length.
  - A call with no limit gives 8,192 characters.
  - A pattern gives each match with its offset and the text around it.
  - The pattern `a*` stops, and it gives at most 20 matches.
  - An unknown reference, and a reference of a different analysis, give `not_found`.
  - An offset past the end gives `out_of_range`, and the pattern `(` gives `invalid_pattern`.
  - A page of 16,384 quotes gives a result of at most 32,256 characters, an `end` below 16,384, and `more: true`.
  - A fake store that gives `err` makes `execute` throw.
- [x] 3.14 In `src/loop/tool-output.test.ts`, add a test in which the model reads the reference of its own excerpt. Expected result: the loop does not cut the result of `read_tool_output`.
- [x] 3.15 Run `tsc -p tsconfig.json`. Run `bun test src/tools/read-tool-output.test.ts src/loop/tool-output.test.ts`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 4. The sandbox agents and the step body

- [x] 4.1 In `src/agents/sandbox/shared.ts`, add `readonly toolOutputStore?: ToolOutputStore` to `SandboxAgentDeps`, with a doc comment.
- [x] 4.2 In `createSandboxAgent`, add `createReadToolOutputTool(deps.toolOutputStore)` directly after `buildWorkspaceTools(...)` when the store is present. Keep it in read-only mode.
- [x] 4.3 In `src/workflows/sandbox-step.ts`, add `readonly toolOutputStore?: ToolOutputStore` to `SandboxStepDeps` and to `SandboxAgentBuildContext`.
- [x] 4.4 In the step body, give `deps.toolOutputStore` to the build context, the options of the task, and the post-step pipeline.
- [x] 4.5 After `buildAgent`, log one warn when the step has a store and `agent.tools` holds no `read_tool_output`.
- [x] 4.6 In `src/execution/post-step-pipeline.ts`, add the field to the deps, beside `usageRecorder`. Give it to `generateFileMetadata` and to `generateStepSummary`.
- [x] 4.7 In `src/execution/artifact-metadata.ts`, add the field to `GenerateFileMetadataOptions`, and give it to the options of `continueAgent`.
- [x] 4.8 In the same file, add `READ_TOOL_OUTPUT_TOOL_ID` to `DESCRIBER_TOOLS`.
- [x] 4.9 In `src/execution/step-summary.ts`, add the field to the options, and give it to `continueAgent`. Add `READ_TOOL_OUTPUT_TOOL_ID` to `SUMMARY_TOOLS`.
- [x] 4.10 In `src/tasks/data-profile.ts`, add `readonly toolOutputStore?: ToolOutputStore` to `DataProfileDeps`. Give it to `sandboxAgentDeps` and to the options of `runToTerminal`.
- [x] 4.11 In `src/agents/sandbox/shared.test.ts`, add these tests:
  - A store adds `read_tool_output` directly after the workspace tools.
  - A read-only agent with a store keeps the tool.
  - The same deps with no store give the same tools without it.
- [x] 4.12 In `src/workflows/sandbox-step.test.ts`, give a store to the rigs. Add these tests:
  - The task keeps the text of a long `execute_command` result in the store.
  - The summary continuation can run `read_tool_output`.
  - An agent with no read tool gives one warn.
- [x] 4.13 In `src/execution/artifact-metadata.test.ts` and `src/execution/step-summary.test.ts`, change each assertion of a mask. Expected result: each mask names `read_tool_output`.
- [x] 4.14 In `src/tasks/data-profile-agent-deps.test.ts`, add a test. Expected result: the profiler declares `read_tool_output` when its deps have a store.
- [x] 4.15 Run `tsc -p tsconfig.json`. Run `bun test src/agents/sandbox/shared.test.ts src/workflows/sandbox-step.test.ts src/execution/artifact-metadata.test.ts src/execution/step-summary.test.ts src/tasks/data-profile-agent-deps.test.ts`.
- [x] 4.16 Run `bun test src/execution/post-step-pipeline.test.ts` with Postgres. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 5. The other agents

- [x] 5.1 In `src/agents/conversation-agent.ts`, add `readonly toolOutputStore?: ToolOutputStore` to `ConversationAgentDeps`. Add the read tool after `createGrepTool(workspaceFs)` when the store is present.
- [x] 5.2 In the same file, give the store to `createGeneratePlanTool` and to `createGenerateAnalogyReportTool`.
- [x] 5.3 In `src/tools/research/generate-plan.ts`, add the field to `GeneratePlanDeps`. Put the read tool after the search tools and before the terminal tools.
- [x] 5.4 In the same file, give the store to the options of `runToTerminal`.
- [x] 5.5 In `src/tools/research/generate-analogy-report.ts`, add the field to the deps. Put the read tool after the search tools, and give the store to the options of the loop.
- [x] 5.6 In `src/tools/research/literature-reviewer.ts`, add the field to `LiteratureReviewerDeps`. Put the read tool last in `reviewerTools`, and give the store to the options of `runAgent`.
- [x] 5.7 In `src/execution/run-synthesis.ts`, add the field to `GenerateRunSynthesisInput`. Put the read tool after the reviewer, and give the store to the reviewer and to `loopDeps`.
- [x] 5.8 In `src/app/synthesize-run.ts` and `src/workflows/execute-analysis.ts`, add the field to the deps, and give it on to `generateRunSynthesis`.
- [x] 5.9 In `src/agents/report-session-agent.ts`, add the field to the deps. Add the read tool after the `grep` tool when the store is present.
- [x] 5.10 In `src/agents/conversation-agent.test.ts` and `src/agents/report-session-agent.test.ts`, add a test each. Expected result: a store adds `read_tool_output`, and no store leaves it out.
- [x] 5.11 In `src/tools/research/literature-reviewer.test.ts`, change the test of the tool inventory. Expected result: with a store, `read_tool_output` comes after the lookup tools.
- [x] 5.12 In `src/execution/run-synthesis.test.ts`, add a test of the tool list. Expected result: `validate_synthesis`, `submit_synthesis`, `report_blocker`, `literature_reviewer`, and `read_tool_output`.
- [x] 5.13 In `src/tools/research/generate-plan.test.ts` and `src/tools/research/generate-analogy-report.test.ts`, add a test each. Expected result: the agent declares `read_tool_output` before its terminal tools.
- [x] 5.14 Run `tsc -p tsconfig.json`. Run `bun test src/agents/conversation-agent.test.ts src/agents/report-session-agent.test.ts src/tools/research/literature-reviewer.test.ts src/execution/run-synthesis.test.ts src/tools/research/generate-analogy-report.test.ts`.
- [x] 5.15 Run `bun test src/tools/research/generate-plan.test.ts` with Postgres. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 6. The composition

- [x] 6.1 In `src/runtime/assemble.ts`, make `const toolOutputStore = createToolOutputStore(conversation.pool)` one time in `assembleCoreRuntime`.
- [x] 6.2 Give it to `registerSandboxStep`, `registerExecuteAnalysis`, `registerDataProfileWorkflow`, `createConversationAgent`, and `createReportSessionAgent`.
- [x] 6.3 Add `"toolOutputStore"` to the `Omit` of each bag of `CoreWorkflowDeps` and of `ConversationAssemblyDeps`. Write their doc comments again.
- [ ] 6.4 In `src/app/chat-turn.ts`, give the root loop of `runChatTurn` the option `toolOutputStore: createToolOutputStore(deps.pool)`.
- [x] 6.5 In `src/index.ts`, export the types `ToolOutputStore` and `KeptToolOutput` beside `RunAgentOptions`.
- [x] 6.6 In `src/runtime/assemble.test.ts`, add a test. Expected result: the conversation agent and the report agent declare `read_tool_output`.
- [ ] 6.7 In `src/app/chat-turn.test.ts`, add a test with a tool that gives 50,000 characters. Expected result: the stored round holds the excerpt.
- [ ] 6.8 In the same test, read `cortex_tool_outputs`. Expected result: the table holds the whole text under the reference of the excerpt.
- [ ] 6.9 Run `tsc -p tsconfig.json`. Run `bun test src/runtime/assemble.test.ts src/app/chat-turn.test.ts` with Postgres. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 7. The stream budget of the sandbox

- [ ] 7.1 In `src/tools/workspace/result-bounds.ts`, set `EXEC_STREAM_BYTE_CAP = TOOL_OUTPUT_KEEP_MAX`, imported from `src/loop/tool-output.ts`.
- [ ] 7.2 Write the module header of `result-bounds.ts` again. The budget bounds the memory and a kept text, and the loop cut keeps the context small.
- [ ] 7.3 In `src/tools/workspace/execute-command.ts`, write the description again. State the budget of 1 MiB for each stream, and the excerpt with a reference.
- [ ] 7.4 In the same description, keep the text that stdout and stderr are not a deliverable.
- [ ] 7.5 In `src/sandbox/submit-exec.ts` and `src/sandbox/create-sandbox.ts`, write the doc comments of the budget again. The budget is the maximum of a kept text.
- [ ] 7.6 In `src/tools/workspace/result-bounds.test.ts`, change each test that names 32 KiB to use `EXEC_STREAM_BYTE_CAP`. Add a test that a stream of 200 KiB stays whole.
- [ ] 7.7 In `src/sandbox/submit-exec.test.ts`, add a test. Expected result: a body with no budget posts `stdoutByteCap` and `stderrByteCap` of 1,048,576.
- [ ] 7.8 In `src/sandbox/create-sandbox.test.ts`, add a test. Expected result: a stdout of 2,097,152 bytes comes back with 1,048,576 bytes, the flag, and the total.
- [ ] 7.9 In `src/tools/workspace/execute-command.test.ts`, change the tests of the bound. Expected result: a stdout of 200 KiB comes back whole, and the description names 1 MiB.
- [ ] 7.10 Run `tsc -p tsconfig.json`. Run `bun test src/tools/workspace/result-bounds.test.ts src/sandbox/submit-exec.test.ts src/sandbox/create-sandbox.test.ts src/tools/workspace/execute-command.test.ts src/tools/workspace/mutate-surface-e2e.test.ts`.
- [ ] 7.11 Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.
- [ ] 7.12 In `images/sandbox-base/server/`, run `go test ./...`. Expected result: the tests of `capturingBuilder` pass, and the server code does not change.

## 8. The CLI

- [ ] 8.1 In `cli/src/modules/harness/run_deps.ts`, give `toolOutputStore: ctx.toolOutputStore` to the `SandboxAgentDeps` of `buildStepAgent` when the context has it.
- [ ] 8.2 In `cli/src/modules/harness/run_deps.test.ts`, add `toolOutputStore: {}` to `fakeBuildContext`. Add a test: the built agent declares `read_tool_output`.
- [ ] 8.3 In `cli/`, run `bun run harness:local`, `bun run typecheck`, `bun run lint`, and `bun test src/modules/harness/run_deps.test.ts`.
- [ ] 8.4 In `cli/`, run `bun run format:file src/modules/harness/run_deps.ts src/modules/harness/run_deps.test.ts`.

## 9. Documents and final checks

- [ ] 9.1 In `CONTEXT.md`, section "Loop primitives", add an item on the cut: the cap, the excerpt, the kept text, and `read_tool_output`.
- [ ] 9.2 In `CONTEXT.md`, section "Memory", write the item "Workflow and sandbox agent loops" again. The full text of a cut result is in `cortex_tool_outputs`.
- [ ] 9.3 In `CLAUDE.md`, section "Storage Layout", add `cortex_tool_outputs` to the app tables. It holds conversation data, the same as `messages`.
- [ ] 9.4 Write each changed sentence of 9.1 to 9.3 in STE. Run `bun ../.claude/hooks/ste-check.ts --file` on each file, and fix each hard finding in the changed text.
- [ ] 9.5 Do not format a markdown file. Run `grep -rn "32 KiB" src`. Expected result: no match.
- [ ] 9.6 Run `tsc -p tsconfig.json`. Expected result: no error.
- [ ] 9.7 Run `bun test`. Expected result: each unit test passes. A database suite uses Postgres.
- [ ] 9.8 Run `bun run lint`. Expected result: no error. Run `bun run format:file` on each file under `src/` that this change changed.
- [ ] 9.9 Run `openspec validate keep-large-tool-results-out-of-the-context --strict` in `harness/`. Expected result: the change is valid.
- [ ] 9.10 In `cli/`, run `bun run harness:local`, `tsc -p tsconfig.json`, `bun test`, and `bun run lint`. Expected result: no error and no failed test.
