# Tasks

## 1. The role filter of the paged ledger read

- [x] 1.1 In `src/state/test/artifacts.page.test.ts`, add tests for the scenarios "The run outputs of an analysis" and "The input rows of an analysis". Compare the `step_output` total with the sum that `countArtifactsByRuns` gives. Make sure that the tests fail before the change.
- [x] 1.2 Add `role?: ArtifactRole` to `ArtifactPageQuery`, and add the `role` condition to `queryArtifactPage` in `src/state/artifacts.ts`. Update the doc comment of the read. Make sure that the tests of 1.1 and the other tests of the file pass.

## 2. The page of the plans of an analysis

- [x] 2.1 In `src/state/test/plans.test.ts`, add tests for each scenario of the requirement "The plan store gives a page of the plans of an analysis". Use runs of the analysis and of a different analysis for `newestRunId`. Make sure that the tests fail before the change.
- [x] 2.2 Move the `supersededBy` subquery of `loadPlanRecord` into one SQL fragment in `src/state/plans.ts`. Make sure that the `loadPlanRecord` tests pass with no other change.
- [x] 2.3 Add `queryPlanPage`, `PlanPage`, and `PlanPageEntry` to `src/state/plans.ts`, as the design describes. Make sure that the tests of 2.1 pass.
- [x] 2.4 Export the read and its types from `src/state/index.ts` and `src/index.ts`. Extend `src/state/test/plan-reads.barrel.test.ts` with the root import. Make sure that the test passes.
- [x] 2.5 Run `bun run format:file` on each changed source file. Run `bun run build`, because the cli resolves the harness through `dist/`. Make sure that the build passes.
