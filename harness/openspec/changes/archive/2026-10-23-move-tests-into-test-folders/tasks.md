# Tasks

Binding constraint for every task: these are pure file moves. Move each test
file, change each relative import and each fixture path of the moved file, and
touch nothing else. Do not rewrite test content, do not fix lint reports of
other rules, do not change source files, do not reformat. Use filesystem `mv`
only — no Git mutation of any kind (no `git add`, `git mv`, `commit`, `stash`,
`restore`, `push`).

Move rule (from the `@inflexa-ai/test-placement` source): each file whose name
matches `*.test.ts` or `*.test.tsx` under `harness/src` moves from
`src/<dir>/<name>.test.ts` to `src/<dir>/test/<name>.test.ts` — the immediate
parent directory of the file must be named `test`. Today that is every test
file (358 by `find src -name '*.test.ts'`). Files without a `.test.ts(x)` name,
including every helper under `src/__tests__/setup/`, stay.

Import rewrite rule: each relative import in a moved file must resolve to the
same target as before the move (`./x.js` becomes `../x.js`; an import of a file
that moved into the same `test/` folder keeps its form). The same holds for each
runtime path that reads a fixture: `join(import.meta.dir, "<rel>")` and
`readFileSync` paths resolve to their old target. Non-relative imports do not
change.

## 1. Tools cluster

- [x] 1.1 Write one repeatable batch script (scratch, under `tmp/` of the repo root, never committed) that, for a directory prefix: moves each `*.test.ts` file into the `test/` folder of its current directory, and rewrites each relative import and each fixture-reading runtime path of each moved file to its old resolved target. Run it over `src/tools/**` (101 test files by the current count, including `src/tools/lib/__fixtures__/fixture-runner.test.ts` and `src/tools/lib/__fixtures__/searxng/web-search.fixtures.test.ts`). Verify: no `*.test.ts` file remains directly under any `src/tools/**` directory outside a `test/` folder, and `bun test src/tools` passes with 0 fail and a file count equal to the moved count.
- [x] 1.2 Grep the moved files of this cluster for leftover relative paths that the script class missed (`import.meta.dir`, `readFileSync`, `new URL`, `__fixtures__`, `__tests__` string literals) and fix each by hand to its old resolved target. Re-run `bun test src/tools` and verify 0 fail.

## 2. Core cluster

- [x] 2.1 Run the batch script over the core trees: `src/state`, `src/lib`, `src/execution`, `src/memory`, `src/loop` (including `src/loop/__fixtures__/scripted-provider.test.ts`), `src/runtime`, `src/workflows` (including `src/workflows/__tests__/dbos/`), `src/agents`, `src/app`, `src/tasks`, `src/contracts`, `src/citations`, `src/literature`, `src/provenance`, `src/prompts`, `src/schemas`, `src/workspace`, `src/sandbox`, `src/reference-data`, `src/config`, `src/auth`, `src/__tests__` (only its two `.test.ts` files. The setup helpers stay), and the root test `src/input-sanitization.test.ts` (it moves to `src/test/input-sanitization.test.ts`). The three clusters of tasks 1–3 hold every one of the 358 test files. Verify: no `*.test.ts` file remains outside a `test/` folder in those trees, and `bun test` over those directories passes with 0 fail and a file count equal to the moved count (168 files in this cluster).
- [x] 2.2 Grep the moved files of this cluster for leftover relative paths (same list as 1.2) and fix each by hand. Re-run the cluster `bun test` and verify 0 fail.

## 3. Render, scan and providers cluster

- [x] 3.1 Run the batch script over `src/report-render` (including `figures/` and `views/`), `src/report-model`, `src/input-scan`, and `src/providers` (including all 16 `src/providers/integration/*.integration.test.ts`, which move to `src/providers/integration/test/`). Verify: no `*.test.ts` file remains outside a `test/` folder in those trees, and `bun test` over those directories passes with 0 fail and a file count equal to the moved count.
- [x] 3.2 Grep the moved files of this cluster for leftover relative paths (same list as 1.2) and fix each by hand. Re-run the cluster `bun test` and verify 0 fail.

## 4. Configuration and full verification

- [x] 4.1 In `harness/oxlint.config.ts`: update the `no-console` exemption entry `src/lib/console-logger.test.ts` to `src/lib/test/console-logger.test.ts`, and delete the `"@inflexa-ai/test-placement": "off"` entry with its comment. Verify: `grep -n "test-placement" oxlint.config.ts` finds no `off` entry.
- [x] 4.2 Full verification run: `bun run lint` passes with `@inflexa-ai/test-placement` on and reports nothing; `bun run typecheck` passes; `bun test` passes with the same counts as the base: 6116 pass, 0 fail, 51 skip, 358 files. Record the four counts.
