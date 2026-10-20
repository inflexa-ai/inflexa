# Tasks

## 1. The route

- [x] 1.1 Add `newestRunId: string | null` to `ApprovePlanBody`, and update the JSDoc of `PlanApprovalResult` in `src/api/runs.ts` (design D3).
- [x] 1.2 Add `newestRunId` to the body schema of `POST {A}/plans/:planId/approve`, and give it to the approval (design D1). Map `run_not_found` to 404 `not_found` in `approvalRefusal` (design D2).
- [x] 1.3 Make sure that tests in `src/server/routes/runs.test.ts` cover each new scenario of "The server approves a plan by its id". A test must show that the approval receives the `newestRunId` of the body, for a run id and for `null`. A test must show 400 for a body with no `newestRunId`, an empty one, and a number. A test must show 404 with its message for `run_not_found`. Give the new member in each existing body and each `ApprovePlanInput` of the tests.

## 2. Verification

- [x] 2.1 Run `bun run harness:local`. Run `bun run format:file` on the changed files in `src/`. Then run `bun run typecheck`, `bun run lint`, and `bun test src/server/routes/runs.test.ts src/server/routes/attention.test.ts src/modules/harness/runtime.test.ts`. Make sure that each command passes.
- [x] 2.2 Run `bun run test` one time for the full cli suite. Make sure that it passes.
