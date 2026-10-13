# Tasks

## 1. The harness link

- [x] 1.1 After the harness change is in place, run `bun run harness:local`. Make sure that `bun run typecheck` resolves `loadPlanRecord`, `queryRunIdsByPlan`, `planGraphOf`, and `planPartOf` from `@inflexa-ai/harness`.

## 2. The plan of a run

- [x] 2.1 Add `planId` to `RunSummary` in `src/api/runs.ts`, and copy it in `toRunSummary` (design D1). Add `planId` to each fixture that the typecheck names. Make sure that `src/server/routes/runs.test.ts` covers the list scenario of the run plan requirement, and that the list sends no new read.
- [x] 2.2 Add `RunPlan` and `plan` to `RunDetail` in `src/api/runs.ts`, and build `plan` in the detail route with `planGraphOf` (design D2). Add `plan` to each fixture that the typecheck names. Make sure that `src/server/routes/runs.test.ts` covers each detail scenario of the run plan requirement. It must also cover a run with no plan, a plan with a cycle, and one plan read for each request.

## 3. One plan

- [x] 3.1 Add `PlanView` to `src/api/runs.ts`, `loadPlanRecord` and `listPlanRunIds` to `RunRoutesOpts`, and `GET /plans/:planId` (design D3). Update `UNEXPECTED` in `src/server/routes/runs.test.ts` and the literal in `src/server/routes/attention.test.ts`. Make sure that `src/server/routes/runs.test.ts` covers each scenario of the plan requirement. It must also cover the run read limit of 101, `hasMoreRuns`, and two reads for each request. It must cover the 503 before `ready` and the 500 of a failed read.

## 4. Verification

- [x] 4.1 Run `bun run format:file` on the changed files. Then run `bun run typecheck`, `bun run lint`, and `bun run test src/server src/client src/tui`. Make sure that each command passes.
- [x] 4.2 Run the full suite `bun run test` one time. Make sure that each failure is the known `src/modules/libs/composition.test.ts` failure (python3 lacks `packaging`), or fix it.
