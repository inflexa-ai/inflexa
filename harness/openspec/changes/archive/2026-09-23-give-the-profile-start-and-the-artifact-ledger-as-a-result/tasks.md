# Tasks

## 1. Artifact ledger

- [x] 1.1 In `src/state/artifacts.ts`, wrap each accessor in `tryQuery` or `tryMutation` with an `op` label `artifacts.<name>`. Keep the SQL and the chunks of `upsertArtifacts`.
- [x] 1.2 In `src/execution/artifact-registration.ts`, add `ArtifactRegistrationFailure` (`refused`, `ledger_failed`). Give a failed upsert and a failed `updateArtifactId` as `ledger_failed`.
- [x] 1.3 In `src/execution/post-step-pipeline.ts`, extend `StepRegistrationFailure` with the new union, and describe `ledger_failed` with `describeDbError`.
- [x] 1.4 Keep the Result at `pinReportSnapshot`. Use `unwrapOrThrow` in the step body of the upstream handoff and in the body of the data profile. Use `unwrapOr(0)` for the count of the run artifacts.

## 2. Profile trigger and run

- [x] 2.1 In `src/tasks/data-profile.ts`, add `DataProfileStartError` and `describeDataProfileStartError`.
- [x] 2.2 Make the dispatch of a claimed profile give `Result<void, DataProfileStartError>` after it settles the row. Let a rejected `authorize` promise pass through after the compensation.
- [x] 2.3 Make `runDataProfile` give `ResultAsync<void, DataProfileStartError>`.
- [x] 2.4 Make `triggerDataProfile` give `ResultAsync<DataProfileTriggerResult, DbError>`. Keep the fire-and-forget dispatch.
- [x] 2.5 Export `DataProfileStartError` and `describeDataProfileStartError` from `src/index.ts`.

## 3. Callers and tests

- [x] 3.1 Update the harness tests that seed or read artifacts to unwrap the Result.
- [x] 3.2 Add the tests for `runDataProfile` (`refused`, `start_failed`), for a ledger fault of the trigger, and for a failed ledger write of the registration.
- [x] 3.3 Update the `cli/` callers: the parity and force drives (`profile_trigger.ts`) and the profile command (`dev/profile.ts`).

## 4. Verify

- [x] 4.1 Run `bun run format:file` on each changed file under `src/`.
- [x] 4.2 Run `tsc -p tsconfig.json`, `bun run lint`, and `bun run test:full` in `harness/`.
- [x] 4.3 Run `bun run harness:local`, then `bun run typecheck`, `bun run lint`, and `bun run test` in `cli/`.
