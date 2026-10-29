# Tasks

## 1. The step counts of a list of runs

- [x] 1.1 In `src/state/test/step-executions.test.ts`, add a test for the scenario of the spec delta. Add a second run id of a different analysis, and an empty list. Make sure that the test fails before the change.
- [x] 1.2 Add `countStepsByRuns` and its row type to `src/state/step-executions.ts`. Make sure that the test passes.
- [x] 1.3 Export the helper and the type from `src/state/index.ts` and `src/index.ts`. Make sure that `bun run typecheck` and `bun run lint` pass.
