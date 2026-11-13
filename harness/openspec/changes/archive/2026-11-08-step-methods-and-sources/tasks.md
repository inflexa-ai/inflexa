# Tasks

## 1. The child gets the grounding

- [x] 1.1 Add the optional `grounding` and `claimViews` fields to `SandboxStepInput`. Fill them in `buildChildInput` from the plan step and the claim views of the run input.

## 2. The host builds the methods

- [x] 2.1 Add `src/execution/step-methods.ts`. Read the decision records with a confined, bounded read. Build the methods, and render the block.
- [x] 2.2 In `generateStepSummaryAndWrite`, build the methods after the summarizer. Append the block to the markdown, and write the block alone when the summarizer fails.
- [x] 2.3 Add the optional `methods` field to `StepSummarySchema`.

## 3. The step part

- [x] 3.1 Add the `data-step-methods` part to the contract schemas, the contract types, and the part registry.
- [x] 3.2 Emit the part beside the summary at the end of the step body.
- [x] 3.3 Add the part to the list of sidebar parts in `cli/src/tui/layout/message_block.tsx`.

## 4. Verification of the package

- [x] 4.1 Add the tests in `src/execution/test/step-methods.test.ts`, `src/workflows/test/sandbox-step.test.ts`, and `src/workflows/test/execute-analysis.test.ts`.
- [x] 4.2 Run `bun run format:file` on each changed file in `src/`. Then run the typecheck, the lint, the format check, the copy check, and the tests of the harness and of the cli.
