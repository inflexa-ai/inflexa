# Tasks

## 1. The run reads

- [x] 1.1 Add the text condition of design D1 to `src/state/runs.ts`. Add the optional `q` to `queryRunsByAnalysis`, `queryRunsByThread`, and `queryActiveRunsByAnalysis`. Keep the statement of each read with no `q` as it is now.
- [x] 1.2 Add `countRunsByAnalysis` to `src/state/runs.ts` (design D2). Export it from `src/state/index.ts` and from the root barrel `src/index.ts`, beside `queryRunsByAnalysis`.
- [x] 1.3 Make sure that `withSchema` tests in `src/state/runs.test.ts` cover each new scenario of "Run query helpers". A test must show a match by the run id, by the plan title, and with no regard to case. A test must show that `_` matches only itself. A test must show that the filter applies before the limit and that the count agrees. A test must show that a plan of a different analysis gives no title. A test must show `q` with the thread read and with the active read.

## 2. The artifact page read

- [x] 2.1 Add `path` and `extensions` to `ArtifactPageQuery` in `src/state/artifacts.ts`, with the conditions of design D3 and D4. Add the type `ArtifactExtensionCount` and the member `extensionCounts` of `ArtifactPage`. Make the count statement group by the extension (design D5). Update the JSDoc of the read and of its types.
- [x] 2.2 Export `ArtifactExtensionCount` from the root barrel `src/index.ts` beside the other artifact page types.
- [x] 2.3 Make sure that `withSchema` tests in `src/state/artifacts.page.test.ts` cover each new scenario of "One read gives a page of the artifact ledger of an analysis". A table test must show the extension of each of these paths:

  - a name with uppercase letters
  - a name with two dots
  - a name that starts with its only dot
  - a name that ends with a dot
  - a name with no dot in a folder with a dot. A test must show that each existing scenario still passes, and that the read sends two statements with each filter.

## 3. Verification

- [x] 3.1 Run `bun run format:file` on the changed files in `src/`. Then run `bun run typecheck`, `bun run lint`, and `bun run test:full src/state/runs.test.ts src/state/artifacts.page.test.ts src/state/artifact-reads.barrel.test.ts`. Make sure that each command passes.
- [x] 3.2 Run `bun run test:full` one time for the full harness suite. Make sure that it passes.
