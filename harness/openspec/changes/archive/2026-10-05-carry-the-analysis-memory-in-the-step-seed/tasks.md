# Tasks

Each path is relative to `harness/`.

## 1. The renderer

- [x] 1.1 In `src/prompts/briefing.ts`, add `ANALYSIS_MEMORY_HEADING`, the type `StepMemory`, and `emptyStepMemory`.
- [x] 1.2 Add `renderMemory`. It gives the goal and each constraint with its origin, and it obeys `WORKING_MEMORY_LIMITS`. An empty memory gives `""`.
- [x] 1.3 Add the field `memory` to `StepBriefing`. `composeStepBriefing` renders the section after the task.

## 2. The reads

- [x] 2.1 In `src/workflows/execute-analysis.ts`, add `gatherStepPackage`. It reads the data-profile status, working memory, and the upstream handoffs, and it gives a `StepBriefing`.
- [x] 2.2 `composeStepSeed` gives `composeStepBriefing(await gatherStepPackage(args))`. A failed memory read logs a warning and gives a seed without the memory section.
- [x] 2.3 Add the field `workingMemory` to `ExecuteAnalysisDeps`.
- [x] 2.4 In `src/runtime/assemble.ts`, omit `workingMemory` from the bag of `buildExecuteAnalysis`. Give `createWorkingMemory(conversation.pool)` in `assembleCoreRuntime`.

## 3. The prompt

- [x] 3.1 In `src/prompts/sandbox-standards.ts`, add one paragraph to "Your Briefing Is Authoritative" that names the section. Use literal text, with no interpolation.

## 4. The tests

- [x] 4.1 In `src/prompts/briefing.test.ts`, add tests for the renderer: the origin labels, the empty memory, the caps, the heading, the replay byte-identity, and the field-coverage guard.
- [x] 4.2 In `src/workflows/step-seed.test.ts`, add tests for a memory row, no row, an edit between two dispatches, a failed read, and replay stability.
- [x] 4.3 In `src/agents/sandbox/shared.test.ts`, make sure that each orient-core variant names the heading of the renderer.
- [x] 4.4 Give `workingMemory` to the deps of `src/workflows/execute-analysis.test.ts` and `src/workflows/__tests__/dbos/suspension-cascade.test.ts`.
