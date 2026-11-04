# Tasks

Constraints for each task:

- Do not do a Git mutation (no stage, commit, push, stash, restore, reset, rebase, checkout, or branch switch). To undo an edit, edit the file again.
- A fix does not change behavior. The one permitted text change is the one of design D1 and D2, and `notes.md` ("Behavior differences") records each test pin that it changes. If a different fix would change a result, do not make it: leave the site as it is, record the site and the reason in `notes.md` ("Open sites"), and report it to the coordinator. The coordinator decides each open site with the reviewers.
- Do not make a test weaker. Do not remove or loosen an `expect` call.
- Do not add a dependency, an `any`, an `as`, a non-null `!`, a `.bind` in a test, a `Reflect.deleteProperty`, or a file-level directive. An inline directive is permitted only for a `typescript/*` rule, only at a site that design D9, D11, D13, or D14 names as deliberate, and only as `oxlint-disable-next-line <rule> -- <reason>`. An `@inflexa-ai/*` rule takes no inline directive: a deliberate site of such a rule is a file of a zone block (design D15).
- Do not change a tool input schema of `src/modules/harness/*_tool.ts`, and do not put `z.json()` in a production schema (design D4).
- An implementor does not run the full `bun run test` or the full `bun run lint`, and does not run `oxlint` over a whole folder such as `src`. Only the coordinator runs the full runs, in task 6.1. Lint with `bun --bun oxlint <paths>` from `cli/`: the paths that you changed, and the file list of your group (`tmp/claude/811/group-<n>-files.txt` at the root of the repository, for example `bun --bun oxlint $(cat ../tmp/claude/811/group-2-files.txt)`). Run `bun run test <files>` on the test files of the sources and the tests that you changed. `bun run typecheck` is permitted. Run one heavy command at a time.
- After you edit a file in `src/`, run `bun run format:file <paths>` on it. Do not format a file outside `src/`.
- After task 1.1, the live lint is the worklist: `bun --bun oxlint <paths>` for a scope, or the start list `tmp/claude/811/811-sites.txt` at the root of the repository. Line numbers move as you edit.
- For each test file that you change, record the count of `expect(` in its source text before and after in the "Test strength" section of `notes.md`. The counts before are in `tmp/claude/811/expect-before.txt` at the root of the repository. The count after is the same or higher.
- Each comment that you add obeys `cli/CLAUDE.md` ("Code Comments"): it states the reason, not the history, and it names no task, no report count, and no change.

## 1. The configuration, the shared helpers, and the docs

- [x] 1.1 In `cli/oxlint.config.ts`, remove the `#811` block (`:257-291`) with its comment. Add `instanceofErrorAllowIn: ["src/lib/cause.ts"]` to the `solid({...})` call, with its reason (design D3). Add the zone blocks of design D4 to D7 after the bun-types test block, each for one rule, with the reason of each file in its comment (design D15). Done when: `rg -n "#811" oxlint.config.ts`, run from `cli/`, prints nothing, and the only `"off"` entries are the bun-types pair and the four zone blocks.
- [x] 1.2 Write `notes.md` in the change folder with these sections: "Measurements" (the count of design Context; the coordinator adds the live count after task group 1), "Site outcomes" (each site whose proof or outcome a design decision asks for, for example D5, D6, and D14), "Behavior differences", "Open sites", and "Test strength" (the `expect(` counts). Done when: the file exists with the five section headings.
- [x] 1.3 Add `messageOf`, `errorOf`, and the errno walk of a cause chain to `src/lib/cause.ts`, each with a JSDoc block (design D1, D3). Move the walk of `isDiskFull` (`src/modules/libs/store_download.ts:1305-1311`) into it, and make `isDiskFull` call it. Fix the own reports of `cause.ts` per design D1. Add the tests of the helpers to `src/lib/test/cause.test.ts` (design D1, D3). Done when: `bun run test src/lib/test/cause.test.ts src/modules/libs/test/store_download.test.ts` passes, `bun --bun oxlint src/lib/cause.ts src/lib/test/cause.test.ts` reports nothing, and no report of `src/modules/libs/store_download.ts` names a line of `isDiskFull`.
- [x] 1.4 Add `stdinIsTTY` to `src/lib/cli.ts` (design D11), the IEC byte formatter in `src/lib/` (design D12), the environment helpers in `src/test_support/` (design D13), the URL reader of a fetch input in `src/test_support/fake_fetch.ts`, and the body reader in `src/test_support/request_body.ts` (design D14). Give each a JSDoc block and a test under the `test/` folder beside it. Done when: each new test passes, and `bun --bun oxlint` on the changed files reports nothing.
- [x] 1.5 In `cli/CLAUDE.md:367-368`, drop the JSX exception of the return type rule (design D8). Write the text in STE. Done when: `rg -n "except for a JSX return" CLAUDE.md`, run from `cli/`, prints nothing.

## 2. The failure text

Scope: the reports of `@inflexa-ai/no-instanceof-error`, `typescript/no-base-to-string`, `typescript/restrict-template-expressions`, `typescript/restrict-plus-operands`, and `typescript/no-unnecessary-template-expression`, in each file under `src/` and `scripts/`, the tests included.

- [x] 2.1 Change each production site of the scope per design D1, D2, D3, D12, and D14. The four byte formatters call the helper of task 1.4 and lose their copies. Record in `notes.md` the proof of each production site of `restrict-template-expressions`: why its value cannot print `"undefined"`. Done when: `bun --bun oxlint $(cat ../tmp/claude/811/group-2-files.txt)` reports no site of the five rules outside the test files, `bun run typecheck` passes, and the test files of each changed source pass.
- [x] 2.2 Change each test site of the scope per design D1 and D14 (the fetch doubles, the captures, and the other conversions). Done when: `bun --bun oxlint $(cat ../tmp/claude/811/group-2-files.txt)` reports no site of the five rules, and each changed test file passes with the same or a higher count of `expect(`.

## 3. The schemas, the type guards, and the declarations

Scope: the reports of `typescript/no-deprecated`, `@inflexa-ai/no-empty-schema`, `@inflexa-ai/no-unknown-type-guards`, `@inflexa-ai/no-typeof-object`, `@inflexa-ai/no-interface`, `@inflexa-ai/export-at-declaration`, `typescript/no-unnecessary-type-parameters`, and `typescript/no-redundant-type-constituents`.

- [x] 3.1 Change each production site of the scope per design D4 to D7 and D14: `.passthrough()` to `z.looseObject`, the reads of D5, the predicates of D6, the interfaces to types, the deletion of the re-export of `agent_switch.ts`, and the two inline directives of `no-unnecessary-type-parameters`. Done when: `bun --bun oxlint $(cat ../tmp/claude/811/group-3-files.txt)` reports no site of the eight rules outside the test files, `bun run typecheck` passes, and the test files of each changed source pass.
- [x] 3.2 Change each test site of the scope per design D4 to D6 and D14: `z.json()` in place of `z.unknown()`, the doc of `parsedJson`, and the predicates. Done when: `bun --bun oxlint $(cat ../tmp/claude/811/group-3-files.txt)` reports no site of the eight rules, `bun run typecheck` passes, and each changed test file passes with the same or a higher count of `expect(`.

## 4. The TSX views

Scope: the reports of `typescript/explicit-function-return-type`, `solid/prefer-show`, and `typescript/no-confusing-void-expression`.

- [x] 4.1 Add the return type of each reported function per design D8. Done when: `bun --bun oxlint $(cat ../tmp/claude/811/group-4-files.txt)` reports no `explicit-function-return-type` site, and `bun run typecheck` passes.
- [x] 4.2 Change each `solid/prefer-show` site to `<Show>`, and each `no-confusing-void-expression` site, per design D14. Done when: `bun --bun oxlint $(cat ../tmp/claude/811/group-4-files.txt)` reports no site of the two rules, `bun run typecheck` passes, and the render tests of each changed view pass (for example `src/tui/test/app_config.render.test.tsx` and the tests under `src/tui/layout/test/` and `src/tui/components/`).

## 5. The other rules

Scope: the reports of `typescript/unbound-method`, `typescript/no-misused-spread`, `typescript/no-dynamic-delete`, `typescript/no-invalid-void-type`, `typescript/no-unnecessary-type-arguments`, `typescript/no-unnecessary-type-conversion`, `typescript/no-unnecessary-boolean-literal-compare`, `typescript/prefer-promise-reject-errors`, and `typescript/only-throw-error`.

- [x] 5.1 Change each production site of the scope per design D9 to D11, D13, and D14. The five stdin sites call `stdinIsTTY`. Done when: `bun --bun oxlint $(cat ../tmp/claude/811/group-5-files.txt)` reports no site of the nine rules outside the test files, `bun run typecheck` passes, and the test files of each changed source pass.
- [x] 5.2 Change each test site of the scope per design D9, D10, D13, and D14. The environment sites call the helpers of task 1.4. Done when: `bun --bun oxlint $(cat ../tmp/claude/811/group-5-files.txt)` reports no site of the nine rules, `bun run typecheck` passes, and each changed test file passes with the same or a higher count of `expect(`.

## 6. Close-out

- [x] 6.1 The coordinator runs `bun run lint`, then `bun run typecheck`, then `bun run test` in `cli/`, one after the other, and records the results in `notes.md`. Done when: the lint run reports nothing, the type check passes, the suite gives 0 fail, and `rg -n "\"off\"" oxlint.config.ts` from `cli/` shows only the bun-types pair and the zone blocks.
