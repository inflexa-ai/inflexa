# Tasks

## 1. The plan part

- [x] 1.1 Add the `grounding` of a plan step and the `claims` of the plan to the types of the `data-plan` part.
- [x] 1.2 Add `PlanClaimViewSchema` and the optional `claims` field to `PlanPartSchema`.
- [x] 1.3 Copy the claim views of the stored plan in `planCardOf`, with the keys of the part schema.

## 2. The live card

- [x] 2.1 Give the full claim views of an accepted plan in the result of the planner sub-agent.
- [x] 2.2 Put the views on the live card in `generate_plan`, and remove them from the result before the model gets it.

## 3. Verification of the package

- [x] 3.1 Add the tests in `src/memory/test/card-builders.test.ts` and `src/tools/research/test/generate-plan.test.ts`.
- [x] 3.2 Run `bun run format:file` on each changed file in `src/`. Then run the typecheck, the lint, the format check, the copy check, and the tests of the harness and of the cli.
