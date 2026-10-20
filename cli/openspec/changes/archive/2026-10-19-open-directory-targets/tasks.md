# Tasks

## 1. Route and types

- [x] 1.1 Rename the route `POST /open` to `POST /open-directory` in `cli/src/server/routes/machine.ts` and update each doc comment that names the old path, and extend `OpenFolderBody` in `cli/src/api/machine.ts` with the `workspace`, `input`, `logs_dir`, `reference_store`, and `package_store` target shapes; verify `bun run typecheck` passes in `cli`
- [x] 1.2 Implement the `workspace` target in the handler with the exact-id `findAnalysis` guard and the `validatePath` + `workspaceReadRoot` + `classifyRealPath` jail: malformed form 400 `validation_error`, escape or absent 404 `not_found`, file 409 `conflict`, unresolvable workspace root 409 `conflict`, folder opened; verify with a route test in `cli/src/server/routes/machine.test.ts` for each of those five outcomes
- [x] 1.3 Implement the `input` target with the exact-id `findAnalysis` guard and the exact `(path, anchorId)` pair match against the registered inputs: no match 404 `not_found`, `isDir` false 409 `conflict` without a disk probe, a resolved path that names a file on disk 409 `conflict`, unresolvable anchor 409 `conflict`, absent folder 404 `not_found`, folder opened; verify with a route test for each outcome
- [x] 1.4 Implement the `logs_dir`, `reference_store`, and `package_store` targets: `logs_dir` opens `env.logDir` as it is with an absent folder 404 `not_found`, the two stores make an absent folder and then open, a file where a store folder belongs is 409 `conflict`, a failed make is 500 `internal_error`; verify with a route test for the make, the file conflict, and the failed make
- [x] 1.5 Keep the directories-only guard over every target that resolves a path from disk, and keep the `output_dir` and `data_dir` behavior unchanged; verify the existing `POST` tests still pass after the path rename with `cd cli && bun test src/server/routes/machine.test.ts`

## 2. Test coverage and regression

- [x] 2.1 Move the `POST /api/v1/open` describe block to `POST /api/v1/open-directory` and cover the new-path success answers for each target of the spec with the recording opener; verify `cd cli && bun test src/server/routes/machine.test.ts` passes
- [x] 2.2 Cover the jail and refusal cases of the spec scenarios that `cli/src/server/routes/machine.test.ts` does not already carry after task 1, including the symbolic-link escape and the input whose record names a folder but whose path holds a file; verify the same test file passes
- [x] 2.3 Run the neighboring regression files `cli/src/server/routes/artifacts.test.ts` and `cli/src/modules/harness/artifact_open.test.ts` to confirm the shared jail helpers still behave; verify both pass with no edit to them

## 3. Full verification

- [x] 3.1 Run the whole required suite one time: `cd cli && bun test`, then `bun run typecheck` and `bun run lint`; verify all three pass
