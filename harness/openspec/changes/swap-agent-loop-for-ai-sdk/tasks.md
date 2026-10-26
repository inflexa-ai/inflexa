# Tasks

## 1. Dependencies

- [ ] 1.1 Bump `@dbos-inc/dbos-sdk` to the latest 5.x (5.1 or later). Read the release notes of DBOS 5, and adapt the boot, the workflow registration, and the DBOS test rig (`src/__tests__/setup/dbos.ts`). Make sure that `tsc -p tsconfig.build.json` and the existing workflow tests pass.
- [ ] 1.2 Add `@dbos-inc/vercel-ai` at an exact version, and keep `ai` on 7 (D16). Make sure that `tsc -p tsconfig.build.json` passes and that the lockfile pins the exact version.

## 2. Model calls

- [ ] 2.1 Wrap the model of each loop with `durableCalls` under one fixed step name, with DBOS step retries off (D2, D3). Do a DBOS workflow test: a recovered workflow gets its completed replies from the checkpoints, and the fake model gets no second request.
- [ ] 2.2 Retry a transient failure inside the model step with a bounded count. Read the versioned AI SDK docs to learn whether `maxRetries` reads `Retry-After`. If it does not, add a small model middleware. Do a unit test: a 503 then a success gives one reply.
- [ ] 2.3 Add the one failure classifier: provider outage, billing refusal, credential, other (D3, D15). Keep the outcome of each class as today. Do a unit test for each class.
- [ ] 2.4 Move the prompt-cache markers and the reasoning effort into the provider options of each request. Do tests: each request marks the system prompt and the last message, the policy `off` marks nothing, and a run with no effort sends none.
- [ ] 2.5 Record the usage of each model call inside the model step (D10). The key holds the run frame, the call path, the invocation id, and the response id. Do a DBOS test: a replay does not grow the counters, and the record key is the same.
- [ ] 2.6 Take the model configuration of a workflow from its input (D2). Do a test: a recovered run uses the model of its input after the configuration changed.

## 3. The tool adapter

- [ ] 3.1 Adapt `defineTool` to AI SDK `tool()` through one adapter, and wrap each tool with `durableTools` (D4). Remove `executionMode` and the inline mode. Do tests: an `err`, a throw, and a schema failure each give an error result. A cancel error passes out of the loop.
- [ ] 3.2 Put the value, the call record, and the pictures in one plain JSON output, and give the model its view through `toModelOutput` (D4, D8). Do tests: the model never reads the record, and the pictures keep their order. A provider with no pictures in tool results gets the text and one warn with the count.
- [ ] 3.3 Fold each call record after each round, in the order of the calls, on the first run and on each replay. Do a DBOS test: a replayed `execute_command` result folds its record.
- [ ] 3.4 Cut a long result inside the tool step, and keep its text under a reference that a rerun gives again. Do tests for the excerpt format, the kept text, the upsert, and a byte-identical excerpt on a rerun.
- [ ] 3.5 Emit `tool-started` and `tool-finished` inside the tool step, with the outcome, the duration of the call, and the detail (D9). Do a test: two parallel calls report their own durations.
- [ ] 3.6 Use `repairToolCall` for input that arrives as a JSON string or inside a fence. Do again the cases of the old `tool-input-repair` tests, written again for the adapter.

## 4. The loop driver

- [ ] 4.1 Write the driver on `streamText` with `stopWhen` (D1). Delete `loop/run-agent.ts`, `loop/run-step.ts`, `loop/continue-agent.ts`, `loop/run-to-terminal.ts`, `loop/tool-mask.ts`, and their tests. Do a test of the append-only rule: each request starts with the system prompt, the tools, and the messages of the request before it, byte for byte.
- [ ] 4.2 Apply the mask, the budget, and the planner guard as one `toolApproval` policy (D5). Delete `loop/call-guard.ts` after the planner moves (6.3). Do tests: a refused call does not run, and it gets the reason. The declared tools do not change, a call in the same round counts, and a replay refuses the same calls.
- [ ] 4.3 Stop the turn on the denial of the user, and continue on a policy refusal (D5). Do a test: the sibling calls of the reply complete, and no model request follows the denial.
- [ ] 4.4 Give each unanswered call a not-run result at each exit, and end the run at the step cap with no wrap-up (D14). Do tests: a reply cut at the output limit, a cap, and a throw each leave no unanswered call.
- [ ] 4.5 Keep the partial reply of an abort from `onChunk`, with the interruption marker. Do a test: an abort mid-stream stores the partial text, and an empty partial adds no message.
- [ ] 4.6 Add the follow-up request and the salvage request over the same prefix (D1). Do tests: the follow-up declares each tool, a policy lets only the named tools run, and only the new messages come back.
- [ ] 4.7 Give each completed round to the round sink before each request, at each exit, and before a throw. Do a test: the store holds a round before the next request.
- [ ] 4.8 Write the finish record at the level of its outcome class. Set the invocation id of the caller on each event of a nested loop. Replace `loop/genai-spans.ts` with `@ai-sdk/otel`, with inputs and outputs not recorded. Do tests: one record for each run, and a nested loop names its tool call on each event.
- [ ] 4.9 Update `harness/CLAUDE.md` ("Append-only agent conversations", "Error handling") and `harness/CONTEXT.md` ("Loop primitives") to the new mechanism. Make sure that `rg "tool-mask|continueAgent|runToTerminal|resultStep|passthroughStep" harness/CLAUDE.md harness/CONTEXT.md` finds nothing.

## 5. Compaction

- [ ] 5.1 Check the budget in `prepareStep`, run the compaction exchange as a follow-up request, and return the new view (D7). The driver records each message that it adds. Do tests: a turn over its budget compacts between two rounds, and the stored transcript equals the sent prefix.
- [ ] 5.2 Keep the summary marker and the records, the path with no summary, the `data-compaction` parts, and the turn-start compaction (specs, compaction requirements). Do a test for each scenario of those requirements.

## 6. Terminal tools and outcomes

- [ ] 6.1 Make `submit_profile` a pure check, and let the workflow take the last accepted submission or resolve the last one as final (D6). Do a DBOS test: a recovery after an accepted submit selects the same profile.
- [ ] 6.2 Make `submit_plan` a pure check. Persist the selected plan after the run through `upsertPlan`, with an id from the call, and let the host fill the snapshot and the template. Do tests: a rerun of the persist stores one plan, and the host values replace the values of the candidate.
- [ ] 6.3 Move the planner guard to the approval policy, and make `knowledge_recommend` and `knowledge_check` plain reads. Read the pin from the recorded results, and stop the planner after its refusal limit. The scenarios of `planner-call-guard` pass as tests.
- [ ] 6.4 Make `request_clarification` and `report_blocker` give a typed result, with a schema refinement for a placeholder text. Let the step agent stop on a blocker result, and select the blocker from the typed result. Do tests: a placeholder gets a refusal, and a blocker stops the step run.
- [ ] 6.5 Make `submit_synthesis` a pure check without `runId`, stamp the run id in the host, and remove `validate_synthesis`. The scenarios of `literature-reviewer` pass as tests.
- [ ] 6.6 Make `submit_analogy_report` a pure check, and select the result after the run. The scenarios of `analogy-report` pass as tests.
- [ ] 6.7 Make `submit_file_metadata` a check for one call, and let the post-step code build the entries from the typed results. Do a test: the entries hold the last description for each path.
- [ ] 6.8 Add the salvage request to each agent with an outcome. Do tests: a run with no outcome gets one salvage, and an aborted run gets none.

## 7. Workspace writes

- [ ] 7.1 Write each file of the mutator through a temporary file in the same directory and a rename (D13). Do a test: no partial file is visible at the target path.
- [ ] 7.2 Add the intent table with a migration. Let `edit_file` insert its intent before the write inside a workflow, and decide a rerun from the hash of the file. Do tests: the hash after gives the stored result, the hash before applies the edit, and another hash gives a conflict.

## 8. The report agent

- [ ] 8.1 Set the provider option for one tool call per reply on the report agent (D12). Do a test: each request of a report conversation carries the option.

## 9. Workflows

- [ ] 9.1 Run the sandbox step agent and the data profiler on the driver, and run the post-step metadata and summary as follow-up requests. Do a DBOS test: a recovered step workflow replays its loop with no model request.
- [ ] 9.2 Run the run synthesis and the literature reviewer on the driver, inside the existing step of the synthesis. Make sure that the run-synthesis tests pass.

## 10. The chat turn and the public surface

- [ ] 10.1 Let the chat turn make its model, its text stream, its usage recorder, and its approval binding from the runtime (D11). Move the ask gateway into the runtime. The scenarios of `chat-turn` pass as tests.
- [ ] 10.2 Remove `runAgent`, `RunStep`, `passthroughStep`, `durableStep`, `createStreamingChat`, and `AgentChat` from `src/index.ts`, and add a harness test kit for the tests of an embedder. The scenarios of `harness-embedder-exports` pass as tests.
- [ ] 10.3 Adapt the CLI to the new surface: `cli/src/modules/harness/turn.ts`, `runtime.ts`, `dev/chat.ts`, `cli/src/server/routes/conversation.ts`, and their tests. Make sure that the CLI typecheck and the CLI tests pass against the linked harness (`bun run harness:local`).

## 11. Specs and documents

- [ ] 11.1 Edit the names of removed functions and step names in the other main specs directly, with no delta (D17). Make sure that `rg "runToTerminal|continueAgent|runAgent|formatStepName|llm-\\{|tool-\\{" harness/openspec/specs` finds nothing.
- [ ] 11.2 Update `harness/README.md` and the "Key Components" of `harness/CLAUDE.md` for the new surface. Make sure that each named symbol exists in `src/`.

## 12. Integration

- [ ] 12.1 Run `bun run format:file` on each changed source file, `tsc -p tsconfig.build.json`, and the full `bun test` one time. Make sure that each passes.
- [ ] 12.2 Run `openspec validate swap-agent-loop-for-ai-sdk` and `openspec validate --specs`. Make sure that both pass.

## Workflow follow-up

- Archive the change after the review of the PR.
- Adapt Cortex in a follow-up PR in its own repository.
- Run the bench, and decide on the truncation recovery and the wrap-up from its results.
- Stage 2 (the durable chat turn) and stage 3 (pause and resume) get their own changes.
