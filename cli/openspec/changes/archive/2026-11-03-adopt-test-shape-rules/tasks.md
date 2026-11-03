# Tasks

Constraints for each task:

- Do not do a Git mutation (no stage, commit, push, stash, restore, reset, rebase, checkout, or branch switch). To undo an edit, edit the file again.
- Do not change the behavior of a reachable path, and do not make a test weaker (design D1, D2, D6, D7). Do not remove or loosen an `expect` call. If a fix must change a result that a test or a caller can see, stop and report to the coordinator.
- Do not add a dependency, an `any`, an `as`, a non-null `!`, or a file-level directive. The only `typescript/require-await` directive of the change is the one of design D3.
- Do not run the full `bun run test` or the full `bun run lint`. Lint the paths of your group with `bun --bun oxlint <paths>` from `cli/`. Run `bun run test <files>` on the test files that you changed and on the tests of the source that you changed. `bun run typecheck` is permitted. Run one heavy command at a time.
- After you edit a file in `src/`, run `bun run format:file <paths>` on it.
- The start list is `tmp/claude/809/scout-sites.txt` under `cli/`. Line numbers move as you edit. After task 1.1, the lint run of your paths gives the current sites.
- Work in large scripted passes where a shape repeats, then fix the remaining sites by hand. Read the type of the real member before you pick a shape (design D1). Run the tests of each file after its pass.
- For each test file that you change, record the count of `expect(` in its source text before and after in the "Test strength" section of `notes.md`. The count after is the same or higher.

## 1. The configuration, the helpers, and the source

- [x] 1.1 In `cli/oxlint.config.ts`, remove the `"typescript/require-await": "off"` entry and its `#809` comment from the last override block. Done when: `rg -n "#809|require-await" oxlint.config.ts`, run from `cli/`, prints nothing, and `bun --bun oxlint oxlint.config.ts` reports nothing.
- [x] 1.2 Write `notes.md` in the change folder with these sections: "Measurements" (the counts of design Context, and the count of the live run of `bun --bun oxlint -f unix src scripts` after task 1.1), "Behavior differences" (design D6, and each difference that a group finds), "New shapes" (each shape that design D1 to D5 does not name, with its fix), and "Test strength" (the `expect(` counts). Done when: the file exists with the four section headings.
- [x] 1.3 Add `streamOf` in the new file `src/test_support/stream.ts` per design D3, with its one directive, and its test under `src/test_support/test/`. Add `respondWith` to `src/test_support/fake_fetch.ts` per design D4, and its test under `src/test_support/test/`. Done when: the two tests pass, and `bun --bun oxlint src/test_support` reports no `require-await` site in the new code.
- [x] 1.4 Fix the three `src/test_support/` sites per design D5 (`fake_client.ts` per D2, `fake_pool.ts`, `server.ts`). Done when: `bun --bun oxlint src/test_support` reports nothing, and `bun run typecheck` passes. The test files under `src/test_support/test/` pass. Each test file that `rg -l "fakeClient|fakePool|fakeTransactionalPool|startTestServer" src` lists passes, in one run.
- [x] 1.5 Add the test of the throw path of `register` to `src/modules/harness/test/prov_bridge.test.ts` per design D5, and run it before the edit. Then fix the five source sites per design D5: `prov_bridge.ts`, `app.launch.tsx` and its callers, `pull.ts` and `src/cli/index.ts`, `commands.tsx`, and `searxng_config.ts`. Done when: the new test passes before and after the edit, `bun --bun oxlint src scripts` reports no `require-await` site outside the test files, `bun run typecheck` passes, and the tests of the changed modules pass.

## 2. The tests of the infra and harness modules

Scope: the test files under `src/modules/infra/` and `src/modules/harness/`.

- [x] 2.1 Fix each `require-await` site of the scope per design D1, D2, and D4. `setup.test.ts` holds the most sites: read its local helpers first, and extend them before you add one. Done when: `bun --bun oxlint src/modules/infra src/modules/harness` reports no `require-await` site, and `bun run typecheck` passes. Each changed test file passes, with the same or a higher count of `expect(` in its source text.

## 3. The other tests of the modules, and the lib, cli, and client tests

Scope: the test files under each other folder of `src/modules/`, and under `src/lib/`, `src/cli/`, and `src/client/`.

- [x] 3.1 Fix each `require-await` site of the scope per design D1 to D4. Done when: `bun --bun oxlint src/modules src/lib src/cli src/client` reports no `require-await` site, and `bun run typecheck` passes. Each changed test file passes, with the same or a higher count of `expect(` in its source text.

## 4. The server and TUI tests

Scope: the test files under `src/server/` and `src/tui/`.

- [x] 4.1 Fix each `require-await` site of the scope per design D1 to D4. The async generators of design D3 are in this scope. Done when: `bun --bun oxlint src` reports no `require-await` site, and `bun run typecheck` passes. Each changed test file passes, with the same or a higher count of `expect(` in its source text.

## 5. Close-out

- [x] 5.1 The coordinator runs `bun run lint`, then `bun run typecheck`, then `bun run test` in `cli/`, one after the other. Then it runs the 63 baseline test files that `tmp/claude/809/test-files.txt` under `cli/` lists. Done when: the lint run, the type check, and the suite pass, and the baseline files give 0 fail, at least 2183 tests, and at least 7573 `expect()` calls (design D7).
