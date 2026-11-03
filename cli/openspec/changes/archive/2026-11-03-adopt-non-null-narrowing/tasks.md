# Tasks

Constraints for each task:

- Do not do a Git mutation (no stage, commit, push, stash, restore, reset, rebase, checkout, or branch switch). To undo an edit, edit the file again.
- Do not change the behavior of a reachable path, and do not make a test weaker (design D1, D3). Do not remove or loosen an `expect` call.
- Do not replace a `!` with an `as` or a `?.`. Do not replace a `!` with a `?? <placeholder>` that hides the absent case. Do not add an `any`, a new `x is T` predicate over `unknown`, or a new `typeof x === "object"` probe (design Non-Goals).
- Do not run the full `bun run test` or the full `bun run lint`. Lint the paths of your group with `bun --bun oxlint <paths>` from `cli/`. Run `bun run test <files>` on the test files that you changed and on the tests of the source that you changed. `bun run typecheck` is permitted. Run one heavy command at a time.
- After you edit a file in `src/`, run `bun run format:file <paths>` on it.
- The start lists are in `tmp/claude/807/` at the root of the repository. Line numbers move as you edit. After task 1.1, the lint run of your paths gives the current sites.
- Work in large scripted passes where a shape repeats (for example `rows[0]!.x` in the tests), then fix the remaining sites by hand. Run the tests of each file after its pass.

## 1. The configuration, the helper, and the baseline

- [x] 1.1 Remove the three `off` entries of `typescript/no-non-null-assertion`, `typescript/no-unnecessary-type-assertion`, and `typescript/no-unnecessary-condition`, and their `#807` comment line, from the last override of `cli/oxlint.config.ts`. Keep each other entry and comment of that block. Done when: `rg -n "no-non-null-assertion|no-unnecessary-type-assertion|no-unnecessary-condition|#807" cli/oxlint.config.ts` prints nothing.
- [x] 1.2 Write `notes.md` in the change folder with these sections: "Measurements" (the counts of design Context and the benchmark of design D4), "Invariant reads" (each source site that calls `present`, with its invariant), "Condition census" (each condition and type-assertion site, with its class and fix per design D5, and the type evidence of each deletion), "Directives" (each `no-unnecessary-condition` directive, with the devices tried), and "Behavior differences" (each difference on a broken invariant per design D3). Done when: the file exists with the five section headings.
- [x] 1.3 Add `src/lib/present.ts` per design D1, with a JSDoc block that states the rule of use, and `src/lib/test/present.test.ts` with the cases of design D1. Done when: the new test passes, and `bun --bun oxlint src/lib/present.ts src/lib/test/present.test.ts` reports nothing.
- [x] 1.4 Before any edit of `src/modules/fs/search_index.ts`, `src/modules/fs/walk_child.ts`, or `src/lib/fuzzy.ts`, write the scratch benchmark of design D4 in `tmp/claude/807/` and run it. Record the input sizes and the medians in the "Measurements" section of `notes.md`. Done when: `notes.md` holds the baseline numbers.

## 2. The hot reads of the search index and the walk decode

Scope: `src/modules/fs/search_index.ts`, `src/modules/fs/walk_child.ts`, and `src/lib/fuzzy.ts`.

- [x] 2.1 Replace each `!` of the scope per design D4: the accessor methods of `NameIndex`, the field for the last chunk, the `DataView` reads of the record decode with the view over `byteOffset`, `present` for the stack pops, and `for...of` for the dirent loop. Add the decode test of a chunk whose `byteOffset` is not 0 (design D4). Run the benchmark of task 1.4 again and record the numbers. Apply the 10% gate of design D4. Done when: `bun --bun oxlint <the three files>` reports none of the three rules, the tests of `src/modules/fs/test/` and `src/lib/test/` pass, and `notes.md` holds the numbers before and after.

## 3. The other source sites

Scope: each file under `src/` and `scripts/` that is not a test file (`**/test/**`, `*.test.ts`, `*.test.tsx`, `src/test_support/**`) and is not in the scope of group 2.

- [x] 3.1 Replace each `!` of the scope per design D2, in the fix order of design D2. Add a row to the "Invariant reads" section of `notes.md` for each `present` call, and to "Behavior differences" per design D3. Done when: `bun --bun oxlint src scripts` reports no `no-non-null-assertion` site outside the test files, `bun run typecheck` passes, and the tests of the changed modules pass.
- [x] 3.2 Fix each `no-unnecessary-condition` and `no-unnecessary-type-assertion` report of the scope per design D5. For the `Scope` guards, read `src/modules/harness/test/launch_dir_tool.test.ts:72` and the tests of `inflexa_tool.ts` and `inputs_tool.ts` first, and keep each assertion. Add a row to the "Condition census" for each site and to "Directives" for each directive. Done when: `bun --bun oxlint src scripts` reports none of the three rules outside the test files, `bun run typecheck` passes, and the tests of the changed modules pass.

## 4. The tests of the modules

Scope: the test files under `src/modules/**`.

- [x] 4.1 Replace each `!` of the scope per design D1 (`present`, or the drop of a bare `expect` argument whose assertion fails on `undefined` and `null`). Fix each condition and type-assertion report of the scope per design D5. Done when: `bun --bun oxlint src/modules` reports none of the three rules, `bun run typecheck` passes, and each changed test file passes with the same count of `expect` calls in the source text as before.

## 5. The other tests

Scope: each other test file and `src/test_support/**`.

- [x] 5.1 Replace each `!` and fix each condition and type-assertion report of the scope as in task 4.1. Done when: `bun --bun oxlint src` reports none of the three rules, `bun run typecheck` passes, and each changed test file passes with the same count of `expect` calls in the source text as before.

## 6. Close-out

- [x] 6.1 Coordinator close-out: run `bun run lint`, `bun run typecheck`, and the full `bun run test` one time each in `cli/`, one after the other. Done when: each passes, `rg -n "oxlint-disable[^\n]*no-non-null-assertion" cli/src cli/scripts` prints nothing, and each `no-unnecessary-condition` directive under `cli/src` and `cli/scripts` has a row in the "Directives" section of `notes.md`.
