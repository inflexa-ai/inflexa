# Tasks

## 1. The migration

- [x] 1.1 Add the migration `20261014120000_index_the_plans_by_parent_and_the_runs_by_plan` with the two indexes, and register it in `src/state/migrations/index.ts` (design D3). Add the name to the migration list of `src/state/thread-parent-columns.test.ts`. Make sure that a `withSchema` test reads `pg_indexes` and finds `idx_cortex_plans_parent` and `idx_cortex_runs_plan` with their columns.

## 2. The reads

- [x] 2.1 Add `PlanRecord` and `loadPlanRecord` to `src/state/plans.ts` (design D1). Make sure that a `withSchema` test covers each scenario of the lineage requirement, and a tie of creation times. A counting querier must show one statement for each read.
- [x] 2.2 Add `queryRunIdsByPlan` to `src/state/runs.ts` (design D2). Make sure that a `withSchema` test covers each scenario of the run id requirement, and a plan with no run. A counting querier must show one statement for each read.

## 3. The graph and the card

- [x] 3.1 Add `PlanGraphStep` to `src/contracts/chat-parts.ts`, and `planGraphOf` to `src/workflows/plan/graph.ts` (design D4). Make sure that a unit test covers each scenario of the graph requirement, and a duplicate step id and a missing dependency. The levels of a test plan must equal `computeTopologicalLevels` of the same steps.
- [x] 3.2 Add `parentPlanId` to `PlanPart`, `PlanPartSchema`, and `PlanCardData`. Add `planCardOf` and `planPartOf` to `src/memory/card-builders.ts`, and move `buildPlanCardData` onto `loadPlanRecord` (design D5). Make sure that tests cover each scenario of the card requirement and of the part requirement. The test of the stored card must show that the display recorder keeps `parentPlanId`. The tests of `src/tools/workspace/workspace-display.test.ts` and `src/contracts` must pass.

## 4. The exports

- [x] 4.1 Export the names of design D6 from `src/state/index.ts`, `src/contracts/index.ts`, and `src/index.ts`. Make sure that a barrel test imports `loadPlanRecord`, `queryRunIdsByPlan`, `planGraphOf`, and `planPartOf` from `@inflexa-ai/harness`.

## 5. Verification

- [x] 5.1 Run `bun run format:file` on the changed files. Then run `bun run typecheck`, `bun run lint`, `bun run build`, and `bun run test:full src/state src/memory src/contracts src/tools/workspace src/workflows`. Make sure that each command passes.
- [x] 5.2 Run the full harness suite `bun run test:full` one time. Make sure that it passes.
