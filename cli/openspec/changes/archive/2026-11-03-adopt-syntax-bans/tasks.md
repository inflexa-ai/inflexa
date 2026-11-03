# Tasks

Constraints for each task:

- Do not do a Git mutation (no stage, commit, push, stash, restore, reset, rebase, checkout, or branch switch). To undo an edit, edit the file again.
- Do not change the behavior of a reachable path, and do not make a test weaker (design D2, D5, D7). Do not remove or loosen an `expect` call. If a fix must change a result that a test or a caller can see, stop and report to the coordinator.
- Do not add a dependency, an `any`, an `as`, a non-null `!`, or a file-level directive. Each directive of the three bans is `// oxlint-disable-next-line eslint-js/no-restricted-syntax -- <intent>`, on the line before the report.
- Do not run the full `bun run test` or the full `bun run lint`. Lint the paths of your group with `bun --bun oxlint <paths>` from `cli/`. Run `bun run test <files>` on the test files that you changed and on the tests of the source that you changed. `bun run typecheck` is permitted. Run one heavy command at a time.
- After you edit a file in `src/`, run `bun run format:file <paths>` on it.
- The start list is `tmp/claude/808/sites.tsv` at the root of the repository. Line numbers move as you edit. After task 1.1, the lint run of your paths gives the current sites.
- Work in large scripted passes where a shape repeats, then fix the remaining sites by hand. Run the tests of each file after its pass.
- For each test file that you change, record the count of `expect(` in its source text before and after in the "Test strength" section of `notes.md`. The count after is the same or higher.

## 1. The configuration, the primitives, and the notes

- [x] 1.1 In `cli/oxlint.config.ts`, remove the `syntax` constant and its `#808` comment, call `restrictedSyntax()` with no argument, and remove `syntax` from the preset call. Remove the `false` filter of `sharedBans` and the part of its comment that explains the filter. Add a directive with its reason to each regex literal of the file (design D4, last paragraph). Done when: `rg -n "#808|regex: false|jsonParse: false|timers: false|ban !== false" cli/oxlint.config.ts` prints nothing, and `bun --bun oxlint oxlint.config.ts` reports nothing.
- [x] 1.2 Write `notes.md` in the change folder with these sections: "Measurements" (the counts of design Context, and the counts of the live run after task 1.1), "Directives" (each surviving directive of the three bans, with its file, its line, and its intent), "Behavior differences" (design D7, and each difference that a group finds), and "Test strength" (the `expect(` counts). Done when: the file exists with the four section headings.
- [x] 1.3 Add `JSON.parseResult` to `src/extensions/json.ext.ts` per design D1, with the one directive. Make `JSON.parseWith` delegate to it and keep its outer `catch`. Add tests to `src/extensions/test/extensions.test.ts`: a valid value, a `malformed` error with its cause, a `mismatch` error with the zod error, and `parseWith` still `null` for each failure. Done when: the extension tests pass, and `bun --bun oxlint src/extensions` reports nothing for `jsonParse`.
- [x] 1.4 Add `src/lib/timer.ts` with `runAfter`, `runEvery`, and `withinDeadline` per design D3, with one directive for each raw timer call. Add `src/lib/test/timer.test.ts` under fake timers, with these cases:
  - a run after the delay and not before, and no run after the stop
  - a run at each interval until the stop
  - the `unref` option: the handle that a `spyOn(globalThis, "setTimeout")` returns has `hasRef()` false
  - `withinDeadline` for a settle, a timeout, and a rejection.

  Rebuild `Promise.sleep` on `runAfter`, and move its test to fake timers. Done when: the new and changed tests pass, and `bun --bun oxlint src/lib/timer.ts src/lib/test/timer.test.ts src/extensions` reports nothing for `timers`.
- [x] 1.5 Add `src/lib/text.ts` with the tier-1 helpers of design D4 that two or more files use (`trimTrailing`, `isAsciiDigits`, the whitespace test, split, and collapse), built on the string methods. Add `src/lib/test/text.test.ts`. It compares each helper with the pattern that it replaces. The inputs are the empty text, a leading and a trailing separator, a run of separators, `\u00a0`, `\ufeff`, `\u3000`, and a non-ASCII digit. Done when: the test passes, and `src/lib/text.ts` holds no regex.
- [x] 1.6 Add `src/test_support/json.ts` with `parsedJson` per design D5, and its test under `src/test_support/test/`. Done when: the test passes for a valid value, a malformed text, and a mismatch.

## 2. The source JSON and timers

Scope: each file under `src/` and `scripts/` that is not a test file (`**/test/**`, `*.test.ts`, `*.test.tsx`). `src/test_support/*.ts` is in scope.

- [x] 2.1 Replace each `JSON.parse` of the scope per design D1 and D2. Add a malformed-text test for each tolerant boundary of design D2 that has none, before its edit. Done when: `bun --bun oxlint src scripts` reports no `jsonParse` site outside the test files, `bun run typecheck` passes, and the tests of the changed modules pass.
- [x] 2.2 Replace each raw timer of the scope per design D3, with `{ unref: true }` exactly where the site calls `.unref()` today. Done when: `bun --bun oxlint src scripts` reports no `timers` site outside the test files except the two calls of `src/lib/timer.ts`, `bun run typecheck` passes, and the tests of the changed modules pass.

## 3. The source regex

Scope: as group 2.

- [x] 3.1 Replace each regex of the scope per design D4 and D6, in the tier order of design D4. Add a row to the "Directives" section of `notes.md` for each surviving directive, and to "Behavior differences" per design D7. Done when: `bun --bun oxlint src scripts` reports no `regex` site outside the test files, `bun run typecheck` passes, and the tests of the changed modules pass.

## 4. The test JSON and timers

Scope: each test file (`**/test/**`, `*.test.ts`, `*.test.tsx`).

- [x] 4.1 Replace each `JSON.parse` and each raw timer of the scope per design D5 and D3. Done when: `bun --bun oxlint src` reports no `jsonParse` or `timers` site in a test file, and `bun run typecheck` passes. Each changed test file passes, with the same or a higher count of `expect(` in its source text.

## 5. The test regex of the modules

Scope: the test files under `src/modules/**`.

- [x] 5.1 Replace each regex of the scope per design D5, in its tier order. Add `src/test_support/text_shapes.ts` for a shape that two or more test files assert, when the first such shape appears. Add a row to the "Directives" section of `notes.md` for each surviving directive. Done when: `bun --bun oxlint src/modules` reports no `regex` site, and `bun run typecheck` passes. Each changed test file passes, with the same or a higher count of `expect(` in its source text.

## 6. The other test regex

Scope: each other test file.

- [x] 6.1 Replace each regex of the scope as in task 5.1. Done when: `bun --bun oxlint src` reports no site of the three bans, and `bun run typecheck` passes. Each changed test file passes, with the same or a higher count of `expect(` in its source text.

## 7. Close-out

- [x] 7.1 Coordinator close-out: run `bun run lint`, `bun run typecheck`, and the full `bun run test` one time each in `cli/`, one after the other. Done when: each passes. Each directive of the three bans that this change adds has a row in the "Directives" section of `notes.md`.
