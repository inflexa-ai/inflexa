# Tasks

## 1. The reader

- [x] 1.1 Add the grounding view types to `PlanCardStepView` in `src/types/session.ts`.
- [x] 1.2 Copy the grounding of each step in `readPlanCard`. Join each claim id to its view by the id and the snapshot digest.

## 2. The surfaces

- [x] 2.1 Show the grounding section in the step dialog, with a bound on the rules and the sources.
- [x] 2.2 Show the grounding line in the plan card.
- [x] 2.3 Add a grounded step and a grounded plan to the design gallery.

## 3. Verification

- [x] 3.1 Add the tests in `src/modules/harness/test/chat_printer.test.ts`, `src/tui/components/dialog/test/plan_step_detail_dialog.test.tsx`, and `src/tui/components/test/plan_card_block.render.test.tsx`.
- [x] 3.2 Run `bun run format:file` on each changed file in `src/`. Then run the typecheck, the lint, and the tests of the cli.
