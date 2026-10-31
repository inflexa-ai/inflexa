# Tasks

## 1. The kinds of a value and the view of a tool

- [x] 1.1 In `src/contracts/chat-events.ts`, replace `ToolCallValue` with the union of D3 (`text`, `json`, `code` with `language`, and `fields`), and export `ToolCallLeaf`. Update `src/contracts/schemas/chat-events.ts` to a zod schema of the same union, with the rules of the spec (at most 4 fields, the bounds of a name and of a language, no nested `fields`). Update the JSDoc of `src/contracts/message.ts`, and the export lists of `src/contracts/index.ts` and `src/index.ts`. Done when: `src/contracts/schemas/test/chat-events.test.ts` accepts each kind and refuses 5 fields, a bad name, a bad language, and a nested `fields`.
- [x] 1.2 Add `src/tools/tool-view.ts` with the type `ToolCallView<Input, Output>` (`input?`, `result?`, `error?: true`) and the helpers `viewText`, `viewJson`, `viewCode`, and `viewFields`, which return instances of classes of that module. Export them from `src/index.ts`. Done when: a unit test shows that `viewJson("a")` gives the JSON text `"a"`, and that a plain object with a field `kind` is not a helper object.
- [x] 1.3 In `src/tools/define-tool.ts`, add the required `view: ToolCallView<z.infer<Schema>, Output> | "none"` to `ToolDefinition` and the optional `view` to `Tool`. `defineTool` drops `"none"` and keeps a view. Done when: a test in `src/tools/test/` shows that `"none"` packages no `view`, and a `@ts-expect-error` definition with no `view` fails the typecheck.

## 2. The making of a value and the secret forms

- [x] 2.1 In `src/loop/tool-value.ts`, make a `ToolCallValue` from the output of a view member: a helper object gives its kind, a string gives `text`, and each other value gives `json`. Clean each leaf with the existing steps, the cap, and the windows, and check the rules of the spec. A value that breaks a rule gives `undefined`. Make the shown error a `text` leaf of the `error` message of the adapter text. `withoutToolValues` removes `input`, `result`, and `error`. Done when: `src/loop/test/tool-value.test.ts` covers each kind, a cut field, the rule failures, the error text, and the forwarder strip.
- [x] 2.2 In `src/input-sanitization.ts`, add the value-only rules of D8. They cover a private-key block, a URL password, a `--name value` flag, a quoted field with a number, and the word `pass`. Correct the module header, which says that the module never touches a tool result. Done when: `src/test/input-sanitization.test.ts` shows each form of the spec removed, a key block across two windows removed, `PWD=/x` and `max_tokens` unchanged, and `redactSecrets` unchanged.

## 3. The loop events and their readers

- [x] 3.1 In `src/loop/types.ts`, remove the raw `input` of `tool-started`, and rename `inputValue`, `resultValue`, and `errorValue` to `input`, `result`, and `error`. Update `toChatFrame` in `src/contracts/chat-frame.ts` to copy the fields by name. Done when: `src/contracts/test/chat-frame.test.ts` passes with the new names.
- [x] 3.2 In `src/loop/tool-adapter.ts`, run the view of the tool only for a root call (`run.source.callPath` of at most one entry): `input` on the parsed input, `result` on the ok value, and the error text when the view declares `error`. Guard each member as `computeDetail` is guarded, and log a warning on a failure. Done when: `src/loop/test/run-loop.test.ts` covers a view with each member, a view of `input` only, `"none"`, a throwing member, and a sub-agent call with no value.
- [x] 3.3 In `src/loop/run-loop.ts`, give the refused and the denied events the `detail` and the view `input` of the tool from `toolsById`. A refused call gets the refusal text as a `text` error, for each tool. Done when: `src/loop/test/run-loop.test.ts` covers a refused call of a `"none"` tool, and a denied call with an input view.
- [x] 3.4 Make `activityForTool` in `src/sandbox/sandbox-step-translate.ts` take a name and a detail. Let `src/workflows/sandbox-step.ts`, `src/tasks/data-profile.ts`, and `src/tasks/data-profile-activity.ts` pass `event.detail`. Remove `src/tools/detail-resolver.ts` and its test. Done when: `src/sandbox/test/sandbox-step-translate.test.ts`, the data-profile activity tests, and `src/workflows/test/sandbox-step.test.ts` pass, and a forwarded event in `sandbox-step.test.ts` and in `src/workflows/test/execute-analysis.test.ts` holds no `input`, `result`, or `error`.
- [x] 3.5 In `src/tools/script/run-script.ts`, emit the nested start frame with no raw input. Make `ToolCallDisplaySchema` in `src/memory/conversation-display-storage.ts` use the new value schema. Done when: `src/tools/script/test/run-script.test.ts`, `src/memory/test/conversation-display-parity.test.ts`, and `src/memory/test/conversation-display-storage.test.ts` pass with kinded values.

- [x] 3.6 Update `src/app/test/chat-turn.test.ts` and `src/memory/test/conversation-display-parity.test.ts` to get a kinded input, result, and error of one call from the turn stream and from the reloaded transcript. Done when: each test asserts the kind and the text of the three values, and a cut value with `cut` true.

## 4. The view decision of each tool

- [x] 4.1 With one script, add `view: "none",` to each `defineTool` call in `src` and in its tests that has no view. Done when: `bun run typecheck` in `harness/` reports no missing `view`.
- [x] 4.2 Give `run_script` the view of the `script-tools` spec: `viewCode("javascript", code)` for the input, `viewFields` of `output` and `value` for a script that succeeded, `viewFields` of `error` and `output` for a failed script, and `error: true`. Done when: tests in `src/tools/script/test/run-script.test.ts` for each scenario of the spec.
- [x] 4.3 Give the tools of D9 their views: the input, the result, and the error for `write_file`, `edit_file`, `update_working_memory`, `workspace_search`, `list_files`, `file_stat`, `scan_inputs`, `inspect_run`, `inspect_data_profile`, `inspect_capability_data`, `list_available_refs`, `list_available_packages`, `examine_page`, and `list_pinned_artifacts`. Give the input and the error to `read_file`, `grep`, `read_tool_output`, `generate_plan`, and `execute_analysis`. Done when: a test of the views shows that `read_file` gives an input and no result, and that `write_file` gives an input and a result.

## 5. The host tools of the cli

- [x] 5.1 In `cli/src/modules/harness/inflexa_tool.ts`, give `run_inflexa` the view of design D9: the input, the `viewFields` result of each status, and `error: true`. Give `manage_inputs` in `inputs_tool.ts` the input, the result, and `error: true`. Give `list_launch_dir` in `launch_dir_tool.ts` `"none"`. Add `view: "none"` to each `defineTool` call in the cli tests. Done when: `bun run build` in `harness/`, then `bun run typecheck` and the tests of the three tools in `cli/`.

## 6. Comments and the final checks

- [x] 6.1 Correct each comment that names the old fields or the raw input. Examples are the JSDoc of `EmitEvent` and `ToolCallPart`, and the `env` comment of `execute_command`. Done when: `rg -n "inputValue|resultValue|errorValue|withoutToolValues" src` shows only the current names, and no comment names the raw input of an event.
- [x] 6.2 Run `bun run format:file` on each changed file in `src`, then `bun run typecheck`, `bun run lint`, and `tsc -p tsconfig.build.json` in `harness/`. Done when: each command exits with 0.
