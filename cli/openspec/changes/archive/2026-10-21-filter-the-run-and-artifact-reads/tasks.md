# Tasks

## 1. The run list

- [x] 1.1 Move `filterValue` from `src/server/routes/artifacts.ts` to `src/server/http.ts` as an export (design D1). Make sure that the artifacts route imports it and that `src/server/routes/artifacts.test.ts` passes with no change.
- [x] 1.2 Read `q` in `GET {A}/runs`, change the read types of `RunRoutesOpts`, and give `q` to each branch of `listRunPage` (design D2). Make the default `listRuns` use `queryRunsByAnalysis` and `countRunsByAnalysis`. Update the JSDoc of `RunList` in `src/api/runs.ts` (design D6).
- [x] 1.3 Make sure that tests in `src/server/routes/runs.test.ts` cover each scenario of "The run list finds the runs by a text". A test must show that each branch read receives `q`, and that the response gives the `total` of the count read. A test must show that an empty `q` gives no `q` to the read. Give the new read types in each existing stub.

## 2. The artifact list

- [x] 2.1 Add `ArtifactExtensionCount` and the member `extensionCounts` of `ArtifactList` to `src/api/artifacts.ts` (design D5, D6).
- [x] 2.2 Read `path` and `extension` in `GET {A}/artifacts`, and give them to the read as `path` and `extensions` (design D3, D4). Add `extensionCounts` to the response. Update the JSDoc of `artifactRoutes`.
- [x] 2.3 Make sure that tests in `src/server/routes/artifacts.test.ts` cover each new scenario of "The server lists the artifact ledger of an analysis". A test must show that the read receives `path` unchanged. A test must show the normalized `extensions` for uppercase letters, spaces, and empty members. A test must show that a value with no member gives no `extensions`. A test must show that the response gives `extensionCounts` of the read. Give `extensionCounts` in each existing stub.

## 3. Verification

- [x] 3.1 Run `bun run harness:local`. Run `bun run format:file` on the changed files in `src/`. Then run `bun run typecheck`, `bun run lint`, and `bun run test src/server/routes/runs.test.ts src/server/routes/artifacts.test.ts`. Make sure that each command passes.
- [x] 3.2 Run `bun run test` one time for the full cli suite. Make sure that it passes.
