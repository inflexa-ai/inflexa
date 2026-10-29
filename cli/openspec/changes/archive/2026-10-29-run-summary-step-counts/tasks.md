# Tasks

## 1. The step counts of a run summary

- [x] 1.1 In `src/server/routes/runs.test.ts`, add tests for the two scenarios of the spec delta and for the detail route. Make sure that they fail before the change.
- [x] 1.2 Add the three optional fields to `RunSummary` in `src/api/runs.ts`.
- [x] 1.3 In `src/server/routes/runs.ts`, add the `countSteps` option and the read for the list and the detail. Make sure that the route tests pass.
- [x] 1.4 Run `bun run format:file` on the changed files, then `bun run typecheck` and `bun run lint`, and make sure that each passes.
