# Tasks

## 1. The methods of a run

- [x] 1.1 Give each decision record its file, and add `readStepMethods`, `claimViewsOfGrounding`, and `citationKeyOfSource` to `src/execution/step-methods.ts`.
- [x] 1.2 Add `readRunMethods` in `src/execution/run-methods.ts`. Read the stored plan of the run and the decision records of each step.

## 2. The report step

- [x] 2.1 Give each upstream handoff the methods and the decision record paths of its dependency in `gatherStepPackage`.
- [x] 2.2 Render the bounded methods of each dependency in `src/prompts/briefing.ts`.

## 3. The synthesis

- [x] 3.1 Add the optional `methodReferences` field to `RunSynthesisSchema`.
- [x] 3.2 Read the methods of the run in the step of the summaries. Pass them to the synthesizer, and list the method sources in its seed.
- [x] 3.3 Add the method reference check to `submit_synthesis`, and tell the synthesizer how to cite a method source.

## 4. The report session

- [x] 4.1 Add `citationKey` and `normalizeCitationKey` to the report reference contract. Use them in the resolver and the renderer.
- [x] 4.2 Collect the method sources and the method references of each run in the pin. Add the failure kind `plan-read-failed`.

## 5. Verification of the package

- [x] 5.1 Add the tests in `src/execution/test/run-methods.test.ts`, `src/execution/test/run-synthesis.test.ts`, `src/app/test/synthesize-run.test.ts`, `src/report-model/test/pin-snapshot.test.ts`, `src/prompts/test/briefing.test.ts`, and `src/workflows/test/step-seed.test.ts`.
- [x] 5.2 Run `bun run format:file` on each changed file in `src/`. Then run the typecheck, the lint, the format check, the copy check, and the tests of the harness and of the cli.
