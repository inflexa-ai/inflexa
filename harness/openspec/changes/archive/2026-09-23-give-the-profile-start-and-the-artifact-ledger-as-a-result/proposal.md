## Why

A host that never throws must get each failure as a value. Two parts of the harness still do not obey the Result rule of the harness:

- `runDataProfile` rejects when the start of the workflow fails, but it resolves when `RunAuthorizer.authorize` refuses the run. The refusal shows only in the ledger. Thus a host that minted an authorization cannot see that it must revoke it.
- `src/state/artifacts.ts` is the last state module with raw `Promise` accessors. A driver failure is a throw, and each caller needs its own wrapper.

`triggerDataProfile` also catches each fault and gives `"failed"`. Thus a caller cannot tell a refused call from a failed ledger read.

## What Changes

- **BREAKING** `runDataProfile` gives `ResultAsync<void, DataProfileStartError>`. `DataProfileStartError` has two variants: `refused`, with the `reason` and the `suspend` flag of the host, and `start_failed`, with the `cause`. The row is `failed` before the caller gets the `err`, the same as now.
- **BREAKING** `triggerDataProfile` gives `ResultAsync<DataProfileTriggerResult, DbError>`. Each outcome of `DataProfileTriggerResult` stays an `ok` value. A failed ledger read or a failed claim is the `err`. The dispatch after a claim stays fire-and-forget.
- `describeDataProfileStartError` gives a one-line description of a `DataProfileStartError`. The package root exports it and the type.
- **BREAKING** Each export of `src/state/artifacts.ts` gives `ResultAsync<_, DbError>`: `upsertArtifact`, `upsertArtifacts`, `queryInputArtifacts`, `queryUnsyncedStepArtifacts`, `queryStepArtifactPaths`, `queryAnalysisArtifacts`, `countArtifactsForRun`, `updateArtifactId`, and `updateFileIds`.
- `registerStepArtifacts` gives a failed ledger write as an `err` of the variant `ledger_failed`. Its refusal becomes the variant `refused`. The step still fails with the `lineage_attestation` class.

The ledger behavior does not change. A refusal still fails the claimed row with the reason of the host. A failed start still fails the row before the caller gets the outcome. The SQL of each artifact accessor does not change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `data-profile-init`: the profile trigger and the profile run give their outcome as a Result.
- `artifact-manifest`: the artifact ledger helpers give a Result.

## Impact

Harness source:

- `src/tasks/data-profile.ts`: `triggerDataProfile`, `runDataProfile`, `DataProfileStartError`, and `describeDataProfileStartError`.
- `src/state/artifacts.ts`: each accessor.
- `src/execution/artifact-registration.ts` and `src/execution/post-step-pipeline.ts`: the error union of the registration.
- `src/report-model/pin-snapshot.ts` and `src/workflows/execute-analysis.ts`: the callers of the artifact reads.
- `src/index.ts`: the two new exports.

Consumers:

- `cli/`: the profile command and the parity drive take the two Results.
- An embedder that calls `runDataProfile`, `triggerDataProfile`, or an artifact accessor must read a Result. Cortex adopts the change at its next pin of the harness.

Release. The user starts the harness release after the merge. The change does not bump `package.json`.
