# Tasks

## 1. The plan

- [x] 1.1 Add `GroundingDepartureSchema` and the optional `departures` list to the grounding in `src/schemas/workflow-state.ts`.
- [x] 1.2 Refuse a departure with an unknown rule, an unknown setting, a value with no setting, or a second entry for one setting in `validatePlan`.
- [x] 1.3 Give a departure the claim id of the step for a rule id in `submit_plan`.
- [x] 1.4 Tell the planner about `grounding.departures` in the description of `knowledge_recommend`.

## 2. The binding and the record

- [x] 2.1 Apply the departures before the intersection in `bindTemplateContract`, and carry them in the binding.
- [x] 2.2 Keep the departures in the decision record of `knowledge_template`.
- [x] 2.3 Refuse a render of an excluded slot with no value or with no override.

## 3. The methods and the briefing

- [x] 3.1 Add the departures to `StepMethods`, to its schema, and to the methods block.
- [x] 3.2 List the departures in the Grounding section of the briefing and in the handoff of a dependency.
- [x] 3.3 Keep the departures in the grounding of the `data-plan` part.

## 4. Verification of the package

- [x] 4.1 Add tests for the validation, the repair, the binding, the record, the methods block, the handoff, and the plan part.
- [x] 4.2 Run `bun run format:file` on each changed file in `src/`. Then run the typecheck, the lint, `format:check`, `dupes`, and the tests of the harness and of the cli.
