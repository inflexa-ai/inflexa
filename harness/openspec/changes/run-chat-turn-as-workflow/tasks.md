# Tasks

## 1. Keys and the model reference

- [ ] 1.1 Take the key of a usage record, of a cut tool output, and of a compaction from the workflow id when the session has no run frame (D2). Do a DBOS test: a rerun of a long tool result in a workflow gives the same reference and one store row.
- [ ] 1.2 Add a model reference to the input of a turn, a run, and the data profile, and resolve the provider from it in the runtime (D12). Do a test: a recovered run uses the model of its input after the configured model changed.

## 2. The stream of a turn

- [ ] 2.1 Give `durableCalls` and `durableTools` the `durableStream` option of the library inside a turn (D4). Write the facts of each tool call (the detail at the start, the outcome and the duration at the end) through the tool writer of the library. Do a DBOS test: a model call that runs again shows its text one time.
- [ ] 2.2 Write the facts of the body (the id of each assistant message, a refused call, a compaction part, a not-run answer, the end with the usage or the error) as `data-*` chunks, in order. Close the stream at the end. Do a test: the reader gives one `finish` at the end.
- [ ] 2.3 Add the reader of a turn on the reader of the library, with the converter to `ChatFrame` and the merge of the stream of each child. Do tests: the frames hold no tool input and no tool output, a second read gives the same frames, and a sub-agent frame carries its call path.

## 3. The turn workflow

- [ ] 3.1 Register the turn workflow at the assembly, with the turn id as the workflow id and an input with ids and settings only (D1). The first step loads the view of the conversation. Do a test: the stored input holds no user input and no credential.
- [ ] 3.2 Take the credential from the function `credentialFor` of the host, at the start of the body and after each wait (D3). A body that gets nothing ends the turn as `interrupted`. Do DBOS tests for a recovery with a credential and with none. The CLI gives its local credential, and Cortex adapts later.
- [ ] 3.3 Make each round write, the close, and the rows of a compaction a step with a key of the turn and the round, with a unique index on the thread and the key (D6). Add the migration. Do a test: a write that runs again stores each row one time.
- [ ] 3.4 Build the display projection of a round from the frames of the round in the stream of the turn. Do a DBOS test: a replayed round keeps its tool part and its card.
- [ ] 3.5 Add the stop of a turn through an in-process abort controller that the body puts, and the cancel with a close of the record when no process runs the turn (D5). Do tests for both paths.
- [ ] 3.6 Refuse a turn on a thread with an open turn record as `turn_in_progress` (D7). Do a test.
- [ ] 3.7 Give the host surface `open`, `read`, `stop`, and `answer` on `CoreRuntime.chatTurns` (D13), and remove the emit sink and the abort signal from the turn. Do a DBOS test: a crash during a tool round continues from the checkpoints, and the turn ends with one outcome.

## 4. Sub-agents

- [ ] 4.1 Run each sub-agent (the literature reviewer, the planner, the analogy reporter) as a child workflow with the id `${workflowId}-${toolCallId}` (D8). Leave the tool out of `durableTools`, and start the child before the first `await`. Outside a workflow, run the body in process. Do DBOS tests: a recovered child makes no model request again, and two children of one reply run at the same time.
- [ ] 4.2 Give the usage of a child back in its result, and add it to the total of the turn. Do a test.
- [ ] 4.3 Move the synthesis of a run out of its outer step, thus its reviewers start as children. Make sure that the run-synthesis tests pass, and do a DBOS test of a crash during the synthesis.

## 5. Approval

- [ ] 5.1 Add the approval hook to `defineTool`, and run it from the `toolApproval` of the loop after the call policy (D9). Do tests: a request writes the ask row and the `data-ask` frame before `execute`, and a grant runs the call with no ask.
- [ ] 5.2 Wait for the answer with `DBOS.recv` in the body, up to the time limit of the ask. Send the answer with `DBOS.send` from `answer`. Do DBOS tests: an answer after a crash, an expired ask, and a rejected ask that stops the turn.
- [ ] 5.3 Deny each request of a hook outside a turn workflow. Remove `ctx.ask`. Do a test.
- [ ] 5.4 Make `web_fetch` refuse an internal address with no ask (decision Q9). Do a test.

## 6. Tool rerun safety

- [ ] 6.1 `update_working_memory`: store the applied call keys in the transaction of the edit (D10). Add the migration. Do a test: a rerun of an add changes nothing.
- [ ] 6.2 `execute_analysis`: take the run id from `${workflowId}:${toolCallId}`, and launch through `DBOSClient` with the run id as the workflow id. Confirm in the DBOS docs that an enqueue from inside a step dedups on the workflow id. Do a DBOS test: a rerun gives the same run and starts no second run.
- [ ] 6.3 `start_report_session`: take the child thread id from the step key, and write the row and the seed in one transaction. Do a test.
- [ ] 6.4 The authoring tools: store a result for each thread and call under a row lock, and give it again on a rerun. Add the migration. Do a test.
- [ ] 6.5 `preview_report` and `record_report_version`: take the part id and the version id from the call. Do tests.
- [ ] 6.6 `derive_table` and the extraction: run the sandbox exec inside the tool step, with the identity from the step, and mint no mandate (D11). Remove the workflows `derive-table-exec` and `extract-values`. Do a test: a rerun of a completed derivation does not run the command again.

## 7. The CLI

- [ ] 7.1 Connect the conversation route to `open` and `read`. Serve the frames as SSE, and add a route that reads a turn again by its id. Connect the stop route to `stop`, and the answer route to `answer`.
- [ ] 7.2 Let the TUI read a turn again after a lost connection.
- [ ] 7.3 Move `run_inflexa` and `manage_inputs` to the approval hook. Check the input again in `execute`.
- [ ] 7.4 Make sure that the CLI typecheck and the CLI tests pass against the linked harness (`bun run harness:local`).

## 8. Specs and documents

- [ ] 8.1 Update `harness/CLAUDE.md` (Chat turn, Session model) and `harness/CONTEXT.md` (Stream model, Workflow scope) for the turn workflow.
- [ ] 8.2 Edit the names of removed functions in the other main specs directly (`ctx.ask`, `derive-table-exec`, `extract-values`).

## 9. Integration

- [ ] 9.1 Run `bun run format:file` on each changed source file, `tsc -p tsconfig.build.json`, `bun run lint`, `bun run typecheck`, and the full `bun test` one time. Make sure that each passes.
- [ ] 9.2 Run `openspec validate run-chat-turn-as-workflow` and `openspec validate --specs`. Make sure that both pass.

## Workflow follow-up

- Archive `swap-agent-loop-for-ai-sdk` before this change. Then remove the requirement "A host gives only its transport values" of `chat-turn`, which this change replaces.
- Archive this change after the review of the PR.
- Adapt Cortex in a later PR in its own repository.
