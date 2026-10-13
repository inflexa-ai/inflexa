# Tasks

## 1. The harness link

- [x] 1.1 After the harness change is in place, run `bun run harness:local`. Make sure that `bun run typecheck` resolves `queryArtifactPage`, `countArtifactsByRuns`, and `readRunSynthesis` from `@inflexa-ai/harness`.

## 2. The artifact list

- [x] 2.1 Add `ArtifactSort`, `ArtifactEntry`, and `ArtifactList` to `src/api/artifacts.ts` (design D1).
- [x] 2.2 Add `GET /` to `artifactRoutes(boot, opts)` behind the runtime gate, and pass the boot in `src/server/app.ts` (design D1). Make sure that `src/server/routes/artifacts.test.ts` covers each scenario of the artifact list requirement. It must also cover the empty filter values, the 503 before `ready`, and the 500 of a failed read.

## 3. The artifact count of a run

- [x] 3.1 Add `artifactCount` to `RunSummary` in `src/api/runs.ts`, and `countArtifacts` to `RunRoutesOpts` (design D2). Make sure that `src/server/routes/runs.test.ts` covers the scenarios of the artifact count requirement. It must show one count read for `perPage` 1 and for `perPage` 200, and the count of `GET {A}/run/:runId`.

## 4. The synthesis of a run

- [x] 4.1 Add `RunSynthesisView` to `src/api/runs.ts`, `readSynthesis` to `RunRoutesOpts`, and `GET /run/:runId/synthesis` (design D3). Make sure that `src/server/routes/runs.test.ts` covers each scenario of the synthesis requirement. It must show that no record read runs for a status other than `produced`. A test of the default `readSynthesis` must read a record in a folder that is not writable.

## 5. Verification

- [x] 5.1 Run `bun run format:file` on the changed files. Then run `bun run typecheck`, `bun run lint`, and `bun run test src/server`. Make sure that each command passes.
- [x] 5.2 Run the full suite `bun run test` one time. Make sure that each failure is the known `src/modules/libs/composition.test.ts` failure (python3 lacks `packaging`), or fix it.
