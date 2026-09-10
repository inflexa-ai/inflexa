## 1. The progress reader

- [x] 1.1 Add `src/workflows/target-assessment/progress-stream.ts`. Export `TargetAssessmentProgressStream`, `TargetAssessmentProgressStreamDeps`, `TargetAssessmentProgressHandler`, `TargetAssessmentProgressSubscribeOptions`, and `createTargetAssessmentProgressStream`.
- [x] 1.2 In `subscribe`, open `DBOS.readStream(assessmentId, TA_PROGRESS_STREAM_KEY)`. Parse each value with `TargetAssessmentProgressEventSchema` against the `payload` field, then pass the event to the handler.
- [x] 1.3 Settle the promise when the stream drains, and settle it promptly when the signal aborts. Ask the generator to wind down on an abort.
- [x] 1.4 Contain each failure: log a read failure, log a throw from the handler, and log a value that does not parse. Continue the subscription in each case.
- [x] 1.5 Default the logger to `createNoopLogger()`, and name it `ta-progress-stream`.
- [x] 1.6 Import `TA_PROGRESS_STREAM_KEY` from `progress.ts`, so no third module names the string.

## 2. The front door

- [x] 2.1 Export the `BioToolKeys` type from `src/index.ts`. Give the reason in the comment above it: it types `ConversationAgentDeps.bioKeys`.
- [x] 2.2 Export `insertAssessment`, `getAssessment`, `updateProgress`, and `listAssessmentsByOrg` from `src/index.ts`, beside the other `state/` helpers.
- [x] 2.3 Export the types of that surface: `InsertAssessmentInput`, `ListAssessmentsOptions`, `TargetAssessmentRow`, `TargetAssessmentListRow`, `TargetAssessmentStatus`, and `TargetAssessmentError`.
- [x] 2.4 Export `createTargetAssessmentProgressStream` and its four types from `src/index.ts`.
- [x] 2.5 Make sure that no terminal writer of the workflow reaches the barrel: `setDossier`, `markFailed`, `markAssessmentSuspended`, `markAssessmentRunning`, and `softDeleteAssessment`.

## 3. The documents

- [x] 3.1 Repair the `RunLauncher` entry of `CONTEXT.md:331`. Remove the sentence about `launchAndAwait` and `LaunchOutcome`, and describe `launch` only.

## 4. Tests

Issue #535 asks for no test, and the root `CLAUDE.md` forbids a test file that
the user does not ask for. Thus this change makes no test file. It adds cases
to the one file that already drives this stream.

- [x] 4.1 Add cases to `src/workflows/__tests__/dbos/target-assessment-internals.test.ts`. Drive a workflow that writes some phases, then read them back through `subscribe`.
- [x] 4.2 Add a case for the abort path: abort the signal mid-stream, then make sure that the promise settles.
- [x] 4.3 Add a case for each contained failure: a handler that throws, and a stream value that does not parse.

## 5. Verification

- [x] 5.1 Run `bun run format:file` on each file that you changed under `src/`.
- [x] 5.2 Run `tsc -p tsconfig.json` and `bun run lint`.
- [x] 5.3 Run `bun test` for the unit suites.
- [x] 5.4 Run `bun run test:full` for the DBOS cases of section 4. This one needs Postgres.
- [x] 5.5 Run `node scripts/smoke.mjs`, so the new exports resolve from the built `dist/`.
