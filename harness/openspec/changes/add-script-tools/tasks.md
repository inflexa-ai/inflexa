# Tasks

## 1. The script tool

- [x] 1.1 Add `@earendil-works/pi-codemode` 1.4.0 to `harness/package.json`, with an exact pin.
- [x] 1.2 Add `createRunScriptTool` in `harness/src/tools/script/run-script.ts`: the script API, `describe`, the result, the bound of the output, the deadline, and the heap limit. `tools/script/test/run-script.test.ts` covers the parallel calls, the failed calls, `describe`, an uncaught error, and the catalog.

## 2. The loop and the conversation agent

- [x] 2.1 Add `scriptTools` to `AgentDefinition` in `loop/types.ts`. Add `withRunScript` to `openConversation` in `loop/run-loop.ts`. The tests of `withRunScript` cover the order and the refusal of an approval hook. The loop test covers the declared tools of a request.
- [x] 2.2 Move the lookups of `createConversationAgent` to `scriptTools`. `agents/test/conversation-agent.test.ts` covers the move and the order of the lookups.
- [x] 2.3 Tell the agent in the section "Literature and Biology" of `prompts/conversation.ts` to run its lookups in `run_script`.
- [x] 2.4 Make the evals script each script tool, and count a nested call of a script as a lookup (`evals/lib/agent.ts`, `evals/lib/run.ts`).

## 3. The CLI embedding

- [ ] 3.1 Add a harness option that gives `wasm` and `workerUrl` to each `CodemodeSandbox` that `run_script` makes.
- [ ] 3.2 Embed the worker entry and the QuickJS wasm in the CLI binary, and give them to the harness through that option. Make sure that `run_script` runs in the compiled binary.

## 4. The documents

- [x] 4.1 Say in the Conversation Agent entry of "Key Components" in `harness/CLAUDE.md` that the lookups are script tools behind `run_script`.
- [x] 4.2 Run `openspec validate add-script-tools --strict` in `harness`, and make sure that it passes.

## 5. The checks

- [x] 5.1 Run `tsc -p tsconfig.build.json` in `harness`, and make sure that it passes.
- [x] 5.2 Run `bun test` in `harness`, and make sure that it passes.

## Workflow follow-up

- Archive `remove-literature-reviewer` before this change. The `uniprot-tools` delta modifies a requirement that `remove-literature-reviewer` adds, and the `literature-search` delta starts from its text. `openspec validate` gives an info for the `uniprot-tools` delta until then.
