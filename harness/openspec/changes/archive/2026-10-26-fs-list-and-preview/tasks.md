# Tasks

## 1. The origin read

- [x] 1.1 Add `ArtifactOrigin` and `queryArtifactOrigins` to `src/state/artifacts.ts`, beside `queryArtifactPage`, as design D1 tells. Give the read a JSDoc that states the one statement, the empty list, and that the caller bounds the list. Make sure that `bun run typecheck` passes.
- [x] 1.2 Export `queryArtifactOrigins` and `ArtifactOrigin` from `src/state/index.ts` and from the root barrel `src/index.ts`, beside `queryArtifactPage` (design D2). Extend `src/state/test/artifact-reads.barrel.test.ts` to pin the read and the type from the package root. Make sure that the test passes.
- [x] 1.3 Add `withSchema` tests to `src/state/test/artifacts.page.test.ts` for each scenario of "One read gives the origin of each path of a list". A test must show a step output, and an `input` row with `null` for the run and the step. A test must show a path with no row, and a row of a different analysis. A test must show that a list of 200 paths sends one query, with `countingQuerier`. A test must show that an empty list sends no query. Make sure that the tests pass.

## 2. Verification

- [x] 2.1 Run `bun run format:file` on the changed files in `src/`. Then run `bun run typecheck`, `bun run lint`, and `bun test src/state/test/artifacts.page.test.ts src/state/test/artifact-reads.barrel.test.ts` with `CORTEX_TEST_PG_URL` set. Make sure that each command passes.
- [x] 2.2 The coordinator runs the full harness suite one time at the end of the work, with `CORTEX_TEST_PG_URL` set. Make sure that it passes.
