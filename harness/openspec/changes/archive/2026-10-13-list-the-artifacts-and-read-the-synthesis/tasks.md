# Tasks

## 1. The artifact ledger reads

- [x] 1.1 Add `queryArtifactPage` to `src/state/artifacts.ts` with the filters, the sorts, the limit, the offset, and the exact `total` (design D1). Make sure that a `withSchema` test covers each scenario of the page requirement. A counting querier must show at most two statements for a limit of 1 and of 200.
- [x] 1.2 Replace `countArtifactsForRun` with `countArtifactsByRuns` (design D2) in `src/state/artifacts.ts`, `src/state/index.ts`, and the run-completed card step of `src/workflows/execute-analysis.ts`. Make sure that a `withSchema` test covers the scenarios of the grouped count requirement. An empty list must send no query, and the workflow tests of the card must pass.

## 2. The synthesis record read

- [x] 2.1 Move the bounded text read of `src/report-model/pin-snapshot.ts` into `src/execution/run-synthesis.ts` with one file-name constant for the writer and the readers (design D3). Make sure that the tests of `src/report-model/pin-snapshot.test.ts` pass with no change to their assertions.
- [x] 2.2 Add `readRunSynthesis({ workspaceRoot, runId })` (design D3). Make sure that a test covers each scenario of the synthesis read requirement. The result must equal the flat part of the synthesis sink, and it must pass `RunSynthesisPartSchema`.

## 3. The contract and the exports

- [x] 3.1 Add `references` to `SynthesizedFinding` in `src/contracts/chat-parts.ts` and to `SynthesizedFindingSchema` in `src/contracts/schemas/chat-parts.ts` (design D4). Make sure that a test covers the scenarios of the references requirement, and that the synthesis-sink test passes.
- [x] 3.2 Export the two ledger reads, the synthesis read, and their types from `src/index.ts` (design D5). Make sure that a barrel test imports them from `@inflexa-ai/harness`, as `src/state/analysis-summary-reads.barrel.test.ts` does.

## 4. Verification

- [x] 4.1 Run `bun run format:file` on the changed files. Then run `bun run typecheck`, `bun run lint`, `bun run build`, and `bun run test:full src/state src/execution src/contracts src/schemas src/report-model src/workflows`. Make sure that each command passes.
- [x] 4.2 Run the full harness suite `bun run test:full` one time. Make sure that it passes.
