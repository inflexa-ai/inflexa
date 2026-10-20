# Tasks

## 1. The bound launch

- [x] 1.1 Add `queryNewestPlanRun` and the optional `startedAt` of `InsertRunInput` to `src/state/runs.ts` (design D2, D4). Make sure that tests in `src/state/runs.test.ts` cover the order and the tie break of the read. They also cover `null` for no run, and a written `startedAt`.
- [x] 1.2 Add the optional `newestRunId` to the input of `launchPlanRun`, the refusal `run_not_found` to `LaunchPlanRunRefusal`, and the compare before the link pass in `launchStoredPlan` (design D1, D2, D5, D6). Add the `run_not_found` case to `throwLaunchRefusal`. Update the JSDoc of `PlanLaunch` and `launchPlanRun`.
- [x] 1.3 Make `reservePlanRun` reserve each stored plan in one `withTransaction` body under the lock `plan-launch:<planId>` (design D3, D4). Compare only for a given `newestRunId`. Insert with the start time of D4. Keep the dedup recovery on the pool, outside the transaction.
- [x] 1.4 Make sure that tests in `src/tools/execute-analysis.test.ts` cover each new scenario of "The harness launches a stored plan through one function". The test plan of the no-link assertion declares a package, and the deps bind a link function that records its calls. The link-pass test makes and ends the run inside that link function. The two-launch test holds the first launch at its insert with a gate on the transaction client. It starts the second launch during that hold. The clock test writes a start of the run `r1` in the future.
- [x] 1.5 Make sure that a test covers "The agent runs a plan again" of the tool. Give `poolFailingOn` a `connect` that applies the same failure to the queries of the client. Thus each existing failure test reaches its statement inside the transaction. Make sure that each existing test of `src/tools/execute-analysis.test.ts` passes with no change of its assertions.

## 2. The approval

- [x] 2.1 Add the required `newestRunId: string | null` to `ApprovePlanInput`, and pass it to `launchPlanRun` in `approve` (design D1). Update the JSDoc of `PlanApproval` (design D6).
- [x] 2.2 Make sure that `withSchema` tests in `src/app/approve-plan.test.ts` cover "A stale approval records nothing" and "An approval of the newest view runs the plan again", and that each other scenario of "The harness approves a plan by its id" gives a newest run id. Give the new member in `src/app/approve-plan.barrel.test.ts` and `src/runtime/assemble.test.ts`.

## 3. Verification

- [x] 3.1 Run `bun run format:file` on the changed files in `src/`. Then run `bun run typecheck`, `bun run lint`, and `bun run test:full src/tools/execute-analysis.test.ts src/app src/runtime/assemble.test.ts src/state/runs.test.ts`. Make sure that each command passes.
- [x] 3.2 Run `bun run test:full` one time for the full harness suite. Make sure that it passes.
