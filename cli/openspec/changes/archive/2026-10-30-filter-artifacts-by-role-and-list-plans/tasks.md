# Tasks

The harness change `filter-artifacts-by-role-and-list-plans` comes first. Run `bun run build` in `harness/` before this work, because the cli resolves the harness through `dist/`.

## 1. The role filter of the artifact list

- [x] 1.1 In `src/server/routes/artifacts.test.ts`, add tests for the scenarios "The run outputs of an analysis" and "A bad role value". Add a test that an empty `role` gives no `role` to the read. Make sure that the tests fail before the change.
- [x] 1.2 In `src/server/routes/artifacts.ts`, read and validate `role` as the design describes, and give it to the ledger read. Update the doc comment of `artifactRoutes`. Make sure that the tests of the file pass.

## 2. The plan list

- [x] 2.1 Add `PlanSummary` and `PlanList` to `src/api/runs.ts`.
- [x] 2.2 In `src/server/routes/runs.test.ts`, add a `GET {A}/plans` block with a test for each scenario of the requirement "The server lists the plans of an analysis". Add a test for 500 `internal_error` when the read fails. Make sure that the tests fail before the change.
- [x] 2.3 In `src/server/routes/runs.ts`, add `listPlans` to `RunRoutesOpts` and its default, move the title rule into one function, and add the route. Make sure that the tests of the file pass.
- [x] 2.4 Run `bun run format:file` on each changed source file. Make sure that `bun run typecheck` passes.
