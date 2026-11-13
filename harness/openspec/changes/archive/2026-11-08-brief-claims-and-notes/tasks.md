# Tasks

## 1. The briefing carries the claim titles, the setting sources, and the template notes

- [x] 1.1 Add the optional `claims` field to `ExecuteAnalysisInput` in `src/workflows/execute-analysis.ts`. Fill it from the stored plan in `src/tools/execute-analysis.ts`.
- [x] 1.2 At dispatch, select the views whose claim id and snapshot digest match the grounding of the step. Give them to the briefing.
- [x] 1.3 In `src/prompts/briefing.ts`, render each claim with its strength and its title. Clamp the title to `CLAIM_TITLE_MAX_CHARS`. Use the statement when the view has no title.
- [x] 1.4 Add the source of a setting to each line under `Unbound settings`.
- [x] 1.5 Copy the notes of the contract into the template brief. Render them in the `Template contract` section, clamped to `TEMPLATE_NOTES_MAX_CHARS`.

## 2. A local refusal gives the slot description

- [x] 2.1 In `src/tools/knowledge/template.ts`, add the description of the slot to each local refusal. Do this before the service call and at the bind after it.

## 3. Verification of the package

- [x] 3.1 Add the tests in `src/prompts/test/briefing.test.ts`, `src/workflows/test/step-seed.test.ts`, and `src/tools/knowledge/test/knowledge-tools.test.ts`.
- [x] 3.2 Run `bun run format:file` on each changed file in `src/`. Then run the typecheck, the lint, the format check, the copy check, and the tests, and make sure that each passes.
