# Tasks

## 1. Harness pool type and comment (design D2, D6)

- [x] 1.1 In `harness/src/execution/run-event-stream.ts`, type `RunEventStreamDeps.pool` as `Querier` of `harness/src/state/db.ts`, and remove the `Pool` import if nothing else reads it. Proof: `bun run typecheck` in `harness/` passes.
- [x] 1.2 Rewrite the comment at `harness/oxlint.config.ts:3-5` as design D2 says, with no plugin version. The vendored set does not change. Proof: `bun run lint` in `harness/` passes.
- [x] 1.3 Run `bun run format:file` on the changed `harness/src/` file. Proof for the harness: `tsc -p tsconfig.build.json`, `bun run lint`, `bun run typecheck`, and `bun test src/execution/test/run-event-stream.test.ts` pass in `harness/` (the database tests use the podman socket, and ryuk runs privileged).
- [x] 1.4 In `cli/`, run `bun run harness:local`, so that the linked harness `dist` holds the new type. Make sure that `cli/node_modules/@inflexa-ai/harness` is a symbolic link to `../../../harness`.

## 2. Remove the pool cast in cli (design D6)

- [x] 2.1 In `cli/src/server/routes/test/runs.test.ts`, remove `asHarnessPool`, its `SAFETY` comment, its directive, and the `Pool` import if nothing else reads it. Pass the stand-in to `createRunEventStream` directly. Proof: `bun test src/server/routes/test/runs.test.ts` passes.
- [x] 2.2 Run `bun run format:file` on the changed file, and `bun run typecheck` in `cli/`. Make sure that no `typescript/no-unsafe-type-assertion` directive remains in `runs.test.ts`, and that `src/test_support/fake_collector.ts` does not change.

## 3. The client import boundary (design D1)

- [x] 3.1 In `cli/oxlint.config.ts`, add the `clientBoundaryBans` entry of design D1, with its message. Correct the comment above `sourceSelector` (`:49-52`). Make sure that `bun run lint` in `cli/` passes.
- [x] 3.2 In `cli/src/client/test/import_boundary.test.ts`, add the computed forms of design D1 for `src/client` and `src/tui`, one form on each line, with texts that no other ban matches. Add a computed form in `src/server` that gives no report. Keep each existing case. Proof: `bun test src/client/test/import_boundary.test.ts`, and make sure that a selector that matches nothing makes the new test fail (for example with a temporary edit of the selector that you then undo).
- [x] 3.3 Add one sentence for the new entry to "The client import rule" of `cli/CLAUDE.md`. Make sure that the paragraph names the written-out path rule.

## 4. Order-independent tests (design D4, D5)

- [x] 4.1 Add `replaceProperty` of design D5 in `cli/src/test_support/replace_property.ts`, with a JSDoc. Add a test in `cli/src/test_support/test/` for an object with an own writable property and for an object with no own property. After the restore, the test asserts the original descriptor (or its absence), and that a plain assignment of the property works. Proof: that test file.
- [x] 4.2 Move `cli/src/lib/test/shutdown.test.ts` and `cli/src/modules/update/test/notice.test.ts` to the helper for `isTTY`, `columns`, and `write`. In the width test of `shutdown.test.ts`, replace the loop of `expect()` calls with one assertion over the frames (design D4). Proof: `bun test src/lib/test/shutdown.test.ts src/modules/update/test/notice.test.ts`, and `bun test --randomize --seed=804 src/modules/update/test/notice.test.ts src/lib/test/shutdown.test.ts` plus two more seeds.
- [x] 4.3 Move the stdin `isTTY` sites of `cli/src/lib/test/cli.test.ts`, `cli/src/modules/infra/test/setup.test.ts` (`:1710`, `:2149`, `:2676`), and `cli/src/modules/embedding/test/setup.test.ts` (`:141`) to the helper. Proof: `bun test` on those three files.
- [x] 4.4 Fix the `afterEach` of `cli/src/modules/harness/test/runtime.test.ts:265-269` so that it removes the skills folder only when the test made one (design D5). Proof: `bun test --randomize --seed=33 src/modules/harness/test/runtime.test.ts` and `--seed=55`.
- [x] 4.5 Make `cli/src/modules/infra/test/setup.test.ts:2097` and `:2111` make the config folder before the write. Find the state that `--no-auth refuses an answered cliproxy provider rather than dropping it` (`:1714`) reads from an earlier test, make the test set it, and record the cause in design D5. Proof: `bun test --randomize --seed=22 src/modules/infra/test/setup.test.ts`, `--seed=55`, and two more seeds.
- [x] 4.6 Make the `createAnalysis makes the empty farm` block of `cli/src/modules/analysis/test/analysis.test.ts` clear the store root before each test too. Proof: `bun test --randomize --seed=11 src/modules/analysis/test/analysis.test.ts` and `--seed=44`.
- [x] 4.7 Run `bun run format:file` on each changed file of this group. Make sure that no changed test file has a lower `expect()` count than before: compare the total that `bun test <file>` prints before and after the change. The width test of design D4 is the exception: its count becomes fixed.

## 5. Fetch doubles and the byte formatter doc (design D7, D8)

- [x] 5.1 Change each site of design D7 to `respondWith(body, init)`, with an import from `src/test_support/fake_fetch.ts`. Proof: `bun test` passes on each changed file, and the multi-line search of design D7 finds only `src/client/test/api.test.ts:222`.
- [x] 5.2 Rewrite the claim of `cli/src/extensions/number.ext.ts:12-13` as design D8 says, with a `{@link}` or a path to `formatIecBytes`. Make sure that no user-visible string changes (`git diff` shows the doc only) and that `bun test src/extensions/test/extensions.test.ts` passes.
- [x] 5.3 Run `bun run format:file` on the changed files.

## 7. Corrections of the implementation review (design D1, D5)

- [x] 7.1 Make the D1 selector refuse a literal that is not a string, as design D1 says, and name the entry by what it refuses in the comment above `sourceSelector`. Add `import(42)` to the computed forms of `cli/src/client/test/import_boundary.test.ts`. Proof: `bun test src/client/test/import_boundary.test.ts` passes, and `bun run lint` in `cli/` passes.
- [x] 7.2 Change `replaceProperty` to the form of design D5 (one restore for each key, registered through `onTestFinished` by default, with the registration as an options parameter), and extend its test to the four cases of design D5. Proof: `bun test src/test_support/test/replace_property.test.ts`, and the same file with `--randomize --seed=88` and `--seed=11`.
- [x] 7.3 Add the shared stderr capture of design D5 to `cli/src/test_support/`, and move each stdio site of design D5 to the new form, with no list of restores, no `afterEach` for them, and no `try`/`finally` for a property. Proof: `bun test` passes on each changed file, and the `expect()` total of each file is the same as before.
- [x] 7.4 Make `src/tui/test/switch_analysis_picker.render.test.tsx` clear the notice store in its cleanup, and make `src/tui/hooks/test/notice.test.ts` and `src/tui/hooks/test/run_completion.test.ts` reset the notice, sidebar, and run completion stores before each test too. Proof: `bun test ./src/tui/test/switch_analysis_picker.render.test.tsx ./src/tui/hooks/test/run_completion.test.ts` and the same pair with `notice.test.ts` pass in that order.
- [x] 7.5 Add the async twin of `withRoot` to `cli/src/test_support/solid.ts`, with a JSDoc, and a test of it beside the test of `withRoot` that proves the dispose after a rejected body. Move each `createRoot(async (dispose) => ...)` site of `run_completion.test.ts` and `activity_panel.test.ts` to it. Proof: `bun test` on the two files and the helper test, and `rg -n 'createRoot\(async' src` in `cli/` finds no test site.
- [x] 7.6 Move the two `mkdirSync` and `writeFileSync` sites of `setup.test.ts` (`:2101`, `:2116`) to `seedConfig`, moved to the scope of the file. Proof: `bun test src/modules/infra/test/setup.test.ts` passes with the same `expect()` total.
- [x] 7.7 Run `bun run format:file` on each changed `src/` file, then `bun run lint` and `bun run typecheck` in `cli/`. Proof: each passes.

## 6. Verification (the coordinator)

- [x] 6.1 Run `bun test --randomize` in `cli/` for each seed of the verification set of design D5, one run at a time. Make sure that no test fails.
- [x] 6.2 Run `bun run lint` and `bun run typecheck` in `cli/` and in `harness/`. Make sure that each passes.
- [x] 6.3 Run the full `bun run test` in `cli/` one time. Make sure that it passes, and record the `expect()` count.
