# Tasks

The CLI groups 1 to 3 come first. Then the harness change `move-source-build-tool-to-cli` (harness tree) runs. Group 4 comes last.

## 1. The interface moves into the CLI

- [x] 1.1 Declare `BuildSource`, `BuildPlan`, `BuildSessionHandle`, `BuildSessionCommand`, `BuildExecResult`, `BuildCommitResult`, `BuildCommitRequest`, and `BuildSession` in `src/modules/libs/build-session.ts`, with the shapes and the JSDoc from `harness/src/sandbox/types.ts:116-198`. Change each JSDoc that names the harness or the embedder so that it names the CLI host tool and the CLI realization. Remove their import from `@inflexa-ai/harness`. Make sure that `bun run test src/modules/libs/build-session.test.ts` passes.
- [x] 1.2 Change the header comment of `src/modules/libs/build-session.ts` so that it names the CLI interface and the CLI host tool, not a harness interface. Make sure that no comment in the file calls the interface a harness interface.

## 2. The host tool

- [x] 2.1 Make `src/modules/harness/source_build_tool.ts` with `createInstallFromSourceTool({ buildSession })`, from `harness/src/tools/install-from-source.ts` at `225ea9e6` (design D2, D3). Keep the id, the schema, the description, `describeCall`, the asks, the grant key, the notes, the session queue, and the rejection and abort paths. Return the whole combined output of an exec, with no `kept` field and no store. Import the harness API from the `@inflexa-ai/harness` barrel alone. Make sure that the tests of 2.2 pass.
- [x] 2.2 Make `src/modules/harness/source_build_tool.test.ts` from `harness/src/tools/test/install-from-source.test.ts` (design D5). Remove the describe block "install_from_source — the roster gating", the case "a long log is cut under the tool-result cap and the whole text is kept for read_tool_output", the case "a long log without a store is cut and carries no reference", and the `recordingStore` helper. Change the case "a short log returns whole, with no kept reference" into a case that an exec returns the whole combined output past the tool-result cap. Keep each other case. Make sure that `bun run test src/modules/harness/source_build_tool.test.ts` passes.
- [x] 2.3 Run `bun run format:file` and `bunx eslint` on the new files and on `src/modules/libs/build-session.ts`. Make sure that ESLint gives no error and that the tests of 2.2 still pass.

## 3. The composition

- [x] 3.1 In `src/modules/harness/runtime.ts`, add the tool to `hostTools` with the realization from `seams.createBuildSession` and the same limits (design D4). Remove `buildSession` from the conversation deps. Change the comment of the binding so that it describes the host tool. Make sure that `bun run test src/modules/harness/runtime.test.ts` passes.
- [x] 3.2 In `src/modules/harness/runtime.test.ts`, change the build-session roster test: `hostTools` holds `install_from_source`, and the composed roster holds it exactly one time. Keep the dead-engine half. Make sure that `bun run test src/modules/harness/runtime.test.ts` passes.
- [x] 3.3 Run `bun run format:file` and `bunx eslint` on the changed files of group 3. Make sure that ESLint gives no error.

## 4. Verification after the harness change

- [x] 4.1 After the harness tasks, build the harness with `bun run build` in `harness/`. Then make sure that `bun run typecheck` in `cli/` gives no error.
- [x] 4.2 Make sure that `bun run test src/modules/harness/source_build_tool.test.ts src/modules/harness/runtime.test.ts src/modules/libs/build-session.test.ts` passes against the new harness build.
- [x] 4.3 Make sure that a search of `cli/src` for `BuildSession` imports from `@inflexa-ai/harness` finds nothing.
- [x] 4.4 (coordinator) Correct the Purpose of `openspec/specs/source-build-session/spec.md:5` so that it names the CLI interface and the CLI host tool, not the harness build session. Make sure that `openspec validate --specs --strict` passes after the archive.
