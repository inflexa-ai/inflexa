# Tasks

## 1. The view tests of the host tools

- [x] 1.1 In `cli/src/modules/harness/inputs_tool.test.ts`, add a `manage_inputs — view` block after the `manage_inputs — describeCall` block. Read the members of the packaged view directly. Use an `add` call with one path. Assert that `input` gives that input and `result` gives the ok value of the call. Assert that the view declares `error`. Done when: `bun run test src/modules/harness/inputs_tool.test.ts` passes in `cli/`.
- [x] 1.2 In `cli/src/modules/harness/launch_dir_tool.test.ts`, add a test beside the `list_launch_dir — describeCall` block that asserts that the packaged tool has no `view` key. Done when: `bun run test src/modules/harness/launch_dir_tool.test.ts` passes in `cli/`.
- [x] 1.3 Compare the `run_inflexa — view` tests in `cli/src/modules/harness/inflexa_tool.test.ts` with each scenario of the `agent-cli-tool` delta. Add a test only for a scenario that they do not cover. Done when: `bun run test src/modules/harness/inflexa_tool.test.ts` passes in `cli/`.

## 2. The harness glossary

- [x] 2.1 In `harness/CONTEXT.md`, correct the `defineTool` entry (`:609-641`). Add the required `view` field to the signature line, and add a short paragraph that says what the view decides: a `ToolCallView` with the optional members `input`, `result`, and `error`, or `"none"`, which shows no value. Point to the `tool-call-values` capability. Show `describeCall` as a required decision, a function or `"none"`, and remove the sentence that calls it optional. Write the text in STE. Done when: the entry names both required decisions, and no sentence of the entry calls `describeCall` optional.

## 3. Checks

- [x] 3.1 In `cli/`, run `bun run format:file` on the changed test files, then `bun run typecheck` and `bunx eslint` on the changed test files. Done when: each command exits with 0.
