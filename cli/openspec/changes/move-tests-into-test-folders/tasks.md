# Tasks

Constraint for each task: move each test file, and change each relative path of
the moved file so that it resolves to its old target (design D1, D5). The only
other permitted edits are these:

- the shared fixture constant of design D4
- the path comments of design D7
- the formatter result of design D8
- the two configuration edits of design D6

Do not change the behavior of a source file or of a test. Do not fix a report of a
different lint rule. Use the filesystem `mv`. Do not use `git mv` or a different Git
command that changes the index, the tree, or the history.

The script moves the directories of one cluster in one pass, thus these directories
finish together. The test run of the cluster covers each of them before the next
cluster starts.

The move rule: each file of `cli/src` whose name matches `*.test.ts` or
`*.test.tsx` moves from `src/<dir>/<name>` to `src/<dir>/test/<name>`. A file with a
different name stays, for example each helper of `src/test_support/` and each
fixture folder (design D2, D3).

## 1. The batch script and the core cluster

- [x] 1.1 Write one repeatable batch script in `tmp/claude/` at the root of the repository. For a list of directories, the script moves each test file of each directory into its `test/` folder. Then it rewrites each relative module specifier of each moved file by one level: static import, `import type`, side-effect import, export-from, dynamic `import()`, and import with an attribute. It does not touch a string that is not a module specifier. It records the resolved absolute target of each relative specifier before the move. After the move, it fails when a specifier does not resolve to that same target. Done when: a run on a scratch copy of one small directory passes. A specifier that you break by hand in that copy fails the check.
- [ ] 1.2 Run the script over `src/lib`, `src/cli`, `src/client`, `src/client/commands`, `src/db`, `src/extensions`, and `src/test_support`. Then fix by hand each `import.meta.dir` path of the moved files: `src/cli/test/agent_policy_tree.test.ts`, `src/cli/test/gen_docs.test.ts` (the cli root needs three `..` segments), and `src/lib/test/env.test.ts` (the child path needs `..` before `env.ts`). Run `bun run format:file` on each moved file. Done when: the resolution check passes. No test file stays outside a `test/` folder in these directories. `bun test` over these directories passes with 0 fail. No `dist-docs` folder exists under `src/`.

## 2. The modules cluster

- [ ] 2.1 Before the moves of this group, add `src/test_support/fixtures.ts`. It exports `FARM_PARITY_FIXTURE`: the absolute path of `src/modules/libs/test-fixtures/farm-parity`, with a JSDoc that says where the pool is and what it is for (design D4). In `composition.test.ts`, `packages.test.ts`, `store.test.ts`, and `store_flight.test.ts` of `src/modules/libs/`, and in `src/server/routes/store.test.ts`, import the constant and delete the local `FIXTURE` constant. Move the location text of the `composition.test.ts` comment into the JSDoc. Run `bun run format:file` on each changed file. Done when: no test file names `test-fixtures`. `bun test src/modules/libs src/server/routes/store.test.ts` passes with 0 fail.
- [ ] 2.2 Run the script over each directory of `src/modules` that holds a test file, and `src/modules/harness/dev` too. Then fix by hand each `import.meta.dir` path and each fixture path of the moved files: `src/modules/harness/test/inflexa_tool.test.ts`, `src/modules/infra/test/setup.test.ts` (the source path needs `..` before `setup_answers.ts`), `src/modules/prov/test/kernel_compat.test.ts`, `src/modules/sbom/test/spdx.test.ts`, and the tests of `src/modules/libs/test/` that read `images/` or `harness/`. Run `bun run format:file` on each moved file. Done when: the resolution check passes. No test file stays outside a `test/` folder under `src/modules`. `bun test src/modules` passes with 0 fail.

## 3. The server and TUI clusters

- [ ] 3.1 Run the script over `src/server` and `src/server/routes`. Fix by hand the dynamic `import()` of `src/server/routes/test/fs.test.ts`, if the script did not change it. Run `bun run format:file` on each moved file. Done when: the resolution check passes. No test file stays outside a `test/` folder under `src/server`. `bun test src/server` passes with 0 fail.
- [ ] 3.2 Run the script over each directory of `src/tui` that holds a test file. Run `bun run format:file` on each moved file. Done when: the resolution check passes. No test file stays outside a `test/` folder under `src/tui`. `bun test src/tui` passes with 0 fail.

## 4. The configuration and the text

- [ ] 4.1 In `oxlint.config.ts`, delete the `"@inflexa-ai/test-placement": "off"` entry and its `// #804` comment. Change the `excludeFiles` entries `src/lib/env.test.ts`, `src/lib/credential.test.ts`, and `src/test_support/harness.test.ts` to their `test/` paths (design D6). Done when: `grep -n "test-placement" oxlint.config.ts` finds nothing. `find src -name '*.test.ts*' -not -path '*/test/*'` finds nothing.
- [ ] 4.2 Change each directory-qualified path to a moved test in the live text of design D7: `CLAUDE.md`, `docs/color_contrast_audit.md`, the comments of the moved tests, `src/test_support/contrast.ts`, `src/test_support/server.ts`, and `scripts/gen_docs.ts`. Do not change a bare file name, the archive, `openspec/changes/bind-knowledge-plane/`, or `docs/audit.md`. Run `bun run format:file` on each changed file of `src/`. Done when: `grep -rnoE "[A-Za-z0-9_./-]*/[A-Za-z0-9_.-]+\.test\.tsx?" CLAUDE.md docs/color_contrast_audit.md scripts src | grep -v "/test/"` in `cli/` prints only `scripts/build.ts`, which names a harness test.

## 5. The full verification

- [ ] 5.1 The coordinator runs `bun run lint`, then `bun run typecheck`, then `bun run test` in `cli/`, one at a time. Done when: the lint passes, and `@inflexa-ai/test-placement` reports nothing. The typecheck passes. The suite gives 0 fail with the base counts of design Context (227 files, 4660 tests, 16967 `expect()` calls). Each difference in the skip count gets an explanation.
