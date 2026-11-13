# Tasks

## 1. The failing tests

- [x] 1.1 In `src/loop/test/run-loop.test.ts`, add a test where one reply calls `edit_file` two times on one file. Make sure that the test fails on the current code because one edit is lost.
- [x] 1.2 In `src/loop/test/run-loop.test.ts`, add a test where one reply calls a tool that is not concurrent two times. Make sure that the test fails on the current code because the calls overlap.
- [x] 1.3 In `src/tools/script/test/run-script.test.ts`, add a test where a script calls a tool that is not concurrent two times in one `Promise.all`. Make sure that the test fails on the current code because the calls overlap.

## 2. The lock and the declaration

- [x] 2.1 Add `src/loop/call-lock.ts`: a FIFO lock that runs one body at a time.
- [x] 2.2 In `src/tools/define-tool.ts`, add `concurrent` to `ToolDefinition` and `Tool`, and add `callLock` to `ToolContext`. Make `defineTool` throw for `startsWorkflow: true` without `concurrent: true`.
- [x] 2.3 In `src/loop/tool-adapter.ts`, make one lock in `adaptTools`. Run each call that is not concurrent under it, and start the timer of the call when the call gets the lock.
- [x] 2.4 In `src/tools/script/run-script.ts`, declare `run_script` concurrent, and run each nested call that is not concurrent under `ctx.callLock`.
- [x] 2.5 Give `callLock` in each test fixture that makes a `ToolContext`.

## 3. The declarations of the tools

- [x] 3.1 Declare `concurrent: true` on each read-only tool: the reads of the workspace, the lookups, the research tools, and the read tools of a report and of a script.
- [x] 3.2 Declare `concurrent: true` on each tool that starts a workflow.
- [x] 3.3 Add the tests of the scenarios that are not in group 1: concurrent calls overlap, two runs do not wait for each other, a script calls concurrent tools in parallel, and the rule of `defineTool`.

## 4. The checks

- [x] 4.1 Run `bun run format:file` on the changed files in `src/`.
- [x] 4.2 Run `tsc -p tsconfig.build.json` and the changed test files. Then run `bun test` one time.
