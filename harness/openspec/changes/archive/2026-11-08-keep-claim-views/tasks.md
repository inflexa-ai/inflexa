# Tasks

## 1. The plan keeps the claim views

- [x] 1.1 Add `ClaimEvidenceSchema`, `ClaimViewSchema`, and the optional `claims` field of `AnalysisPlanSchema` in `src/schemas/workflow-state.ts`. Omit the field from `PlannerPlanSchema` in `src/schemas/plan-schemas.ts`.
- [x] 1.2 In `src/tools/knowledge/client.ts`, add the optional rule, title, severity, license, and evidence URL to the claim schema.
- [x] 1.3 In `src/tools/research/generate-plan.ts`, keep the view of each claim of the last recommend answer in the memory of the planner. When the planner saves the plan, keep the views of the claims that the steps cite. Keep a view only for a step whose digest is the digest of the answer.
- [x] 1.4 Give the id, the title, and the strength of each kept view in the `plan_complete` outcome. Tell the conversation agent in the tool description to name a rule by its title.
- [x] 1.5 In `src/tools/research/test/generate-plan.test.ts`, add a test of the kept views and a test of a plan with no cited claim. Make sure that `PlannerPlanSchema` has no `claims` field.

## 2. Verification of the package

- [x] 2.1 Run `bun run format:file` on each changed file in `src/`. Then run the typecheck, the lint, the format check, the copy check, and the tests of the changed files, and make sure that each passes.
