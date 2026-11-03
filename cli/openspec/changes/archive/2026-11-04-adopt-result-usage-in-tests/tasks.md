# Tasks

Constraints for each task:

- Do not do a Git mutation (no stage, commit, push, stash, restore, reset, rebase, checkout, or branch switch). To undo an edit, edit the file again.
- Do not change product code: a file under `src/` that is not a test file and is not in `src/test_support/`. Do not make a test weaker (design D3, D6). Do not remove or loosen an `expect` call. If a test that intends an ok gets an err, or a fix needs a product change, record the site in `notes.md` and stop (design D3).
- Do not add a dependency, an `any`, an `as`, a non-null `!`, or a file-level directive. The only `must-use-result` directives of the change are the ones of design D4.
- An implementor does not run the full `bun run test` or the full `bun run lint`. Only the coordinator runs them, in task 5.1. Lint the paths that you changed with `bun --bun oxlint <paths>` from `cli/`. Run `bun run test <files>` on the test files that you changed. `bun run typecheck` is permitted. Run one heavy command at a time.
- After you edit a file in `src/`, run `bun run format:file <paths>` on it.
- After task 1.1, the live `bun run typecheck` is the worklist. The start list is `tmp/claude/810/scout-sites.txt` under `cli/`. Line numbers move as you edit.
- For each test file that you change, record the count of `expect(` in its source text before and after in the "Test strength" section of `notes.md`. The counts before are in `tmp/claude/810/expect-before.txt` under `cli/`. The count after is the same or higher.

## 1. The configuration, the helper, and the docs

- [x] 1.1 In `cli/typecheck.config.ts`, remove the override that turns `must-use-result` off for `**/*.test.{ts,tsx}`, with its `#810` comment. Add `awaitOk` to the `consumers` of the `src/**` entry, and give its reason in the comment of the entry (design D1). Done when: `rg -n "#810|\"off\"" typecheck.config.ts`, run from `cli/`, prints nothing, and `bun run typecheck` reports only `must-use-result` sites in test files.
- [x] 1.2 Write `notes.md` in the change folder with these sections: "Measurements" (the count of design Context, and the count of the live `bun run typecheck` after task 1.1), "Site outcomes" (the outcome of each site that design D3 names as an inferred err or a throw, and each other site whose test intends an err), "Behavior differences", and "Test strength" (the `expect(` counts). Done when: the file exists with the four section headings and the live count.
- [x] 1.3 Add `awaitOk` in the new file `src/test_support/result.ts` per design D2, with its JSDoc block. Add its test `src/test_support/test/result.test.ts` per design D2. Done when: the test passes, `bun --bun oxlint src/test_support` reports nothing, and `bun run typecheck` reports no site in `src/test_support/`.
- [x] 1.4 In `cli/CLAUDE.md`, replace the sentence "The rule is off in the test files until #810 fixes their sites." per design D5. Write the text in STE. Done when: `rg -n "#810" CLAUDE.md`, run from `cli/`, prints nothing, and the section names `awaitOk` and `_unsafeUnwrapErr`.

## 2. The yielded Results

- [x] 2.1 Before the move, run `bun run test src/tui/hooks/test/conversation.test.ts src/tui/hooks/test/conversation.interrupt_retract.test.ts` and record the pass count. Move `frameChannel` into `src/test_support/stream.ts` per design D4, with its merged doc comment and its one directive. Import it in the two test files, and delete their copies. Done when: the two test files pass with the same pass count, and `bun run typecheck` reports no site in the two files or in `src/test_support/`.
- [x] 2.2 Add the directive of design D4 at each of the two yields of `src/tui/hooks/test/conversation.render.test.tsx`. Done when: the test file passes, and `bun run typecheck` reports no site in it.

## 3. The awaited sites of the harness module tests

Scope: the report sites under `src/modules/harness/test/` (`runtime.test.ts`, `inflexa_tool.test.ts`, `model_listing.test.ts`, `launch_dir_tool.test.ts`, `inputs_tool.test.ts`).

- [x] 3.1 Change each report site of the scope per design D3. Read the name and the assertions of each test first, then run the test file to confirm each outcome. Done when: `bun run typecheck` reports no site in the scope, and each changed test file passes with the same or a higher count of `expect(` in its source text.

## 4. The other awaited sites

Scope: each other report site, under `src/client/`, `src/lib/`, and the other folders of `src/modules/` (`embedding`, `geo`, `infra`, `libs`, `refs`, `update`).

- [x] 4.1 Change each report site of the scope per design D3. The sites that design D3 names as an inferred err (`compose.test.ts:720`, `setup.test.ts:2824`, `local-provider.test.ts:868`) and the throw site (`refs/test/commands.test.ts:880`) are in this scope. Record their outcomes in `notes.md`. Done when: `bun run typecheck` passes with no report, and each changed test file passes with the same or a higher count of `expect(` in its source text.

## 5. Close-out

- [x] 5.1 The coordinator runs `bun run lint`, then `bun run typecheck`, then `bun run test` in `cli/`, one after the other. Then it runs the 18 baseline test files that `tmp/claude/810/test-files.txt` under `cli/` lists. Done when: the lint run, the type check, and the suite pass, and the baseline files give 0 fail, at least 872 pass, and at least 3091 `expect()` calls in the summary that `bun test` prints (design D6).
