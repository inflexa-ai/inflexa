# Tasks

## 1. The tool and its configuration

- [x] 1.1 Add `jscpd` at the exact version `5.4.2` to `harness/package.json` dev dependencies, and update `harness/bun.lock` with a harness-local install
- [x] 1.2 Write `harness/.jscpd.json`: formats `typescript`, `tsx`, `javascript`, `python`, `r`, `bash`; ignores `**/node_modules/**`, `**/dist/**`, and the generated gallery data directories `src/report-render/gallery/data/**`, `data.new/**`, `data.old/**`; floor `minTokens: 100` and `minLines: 20`; a `"//"` key that gives the reason for the floor, the reason for each ignored tree, and the reason that the data formats stay outside
- [x] 1.3 Add the `dupes` script to `harness/package.json`: `jscpd src scripts --exit-code --fail-on-empty`
- [x] 1.4 Run `bun run dupes` in `harness/` and record the reported clone set. On `26b04a6f` the set is the 23 clones this change measured (3 in the resolvers, 20 in tests). A clone that a newer merge to `main` added is a new copy to remove in this change, not a mismatch.

## 2. The production copies of the report model

Design Decision 5 governs this group and the next two: each copy collapses into a shared abstraction; an ignore region keeps a copy only for a reason the design accepts.

- [x] 2.1 Collapse the duplicated `resolveDerivation` of `harness/src/report-model/fixture-resolver.ts` and `harness/src/report-model/production-resolver.ts` into one shared derivation helper in `harness/src/report-model/` that takes the input resolver as a parameter
- [x] 2.2 Collapse the 29-line row-selection pair (the block inline in the fixture `resolveArtifactValue` and the production `selectCell`) into a shared row-selection helper that takes the rows and the locator
- [x] 2.3 Collapse the 25-line row-bound and column-projection pair of `resolveArtifactTable` in each resolver into one shared table-read helper
- [x] 2.4 Run the tests of `harness/src/report-model/` after the change

## 3. The within-file test copies

- [x] 3.1 Parameterize or share the repeated blocks of `harness/src/sandbox/test/k8s-client.test.ts` (7 reports) into cases or one local helper
- [x] 3.2 Parameterize or share the repeated blocks of `harness/src/tools/test/execute-analysis.test.ts` (3 reports) and `harness/src/report-model/test/validate.test.ts` (2 reports)
- [x] 3.3 Parameterize or share the repeated blocks of `harness/src/execution/test/reconcile-manifest.test.ts` (3 reports)
- [x] 3.4 Run the tests of each file changed in this group

## 4. The cross-file test copies

- [x] 4.1 Move the repeated data-profile fixture block of `harness/src/app/test/data-profile-orientation.test.ts`, `harness/src/app/test/data-profile-view.test.ts`, and `harness/src/tools/research/test/inspect-data-profile.test.ts` into one shared helper at the natural home of the three callers
- [x] 4.2 Move the repeated report-session spawn block of `harness/src/app/test/spawn-report-session.test.ts` and `harness/src/tools/test/start-report-session.test.ts` into one shared helper
- [x] 4.3 Collapse the repeated block of `harness/src/loop/test/metrics.test.ts` and `harness/src/loop/test/prompt-cache.test.ts` into a shared helper, or keep it under an ignore region with its reason
- [x] 4.4 Run the tests of each file changed in this group

## 5. The gate in CI and its verification

- [x] 5.1 Add a step that runs `bun run dupes` to the `lint (harness)` job of `.github/workflows/lint.yml`, after the Typecheck step
- [x] 5.2 Run `bun run dupes` in `harness/` on the finished tree: it must report no clone and exit 0
- [x] 5.3 Do a test of both failure paths: a scratch file under `harness/src` that copies a block at or above the floor makes `bun run dupes` exit non-zero, and a run whose filters match no file exits non-zero; then remove the scratch file
- [x] 5.4 The done-when of the issue holds: `bun run lint`, `bun run typecheck`, and `bun test` pass in `harness/`
