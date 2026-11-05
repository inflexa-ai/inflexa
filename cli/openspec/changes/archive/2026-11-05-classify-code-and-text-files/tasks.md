# Tasks

## 1. The table and the tests of the map

- [x] 1.1 In `src/test_support/file_types.ts`, move `txt` to the `doc`/`text` row, and add the rows `javascript`, `jsx`, `typescript`, and `tsx`. Then add cases in `src/modules/fs/test/file_kind.test.ts` for each scenario of the kind map in the spec delta. Run the test file and make sure that the new cases fail for the expected reason.
- [x] 1.2 In `src/modules/fs/file_kind.ts`, make the same table changes. Make sure that the table cases of `file_kind.test.ts` pass.

## 2. The Linguist fallback

- [x] 2.1 Add `linguist-languages` 9.5.0 to the dependencies of `package.json` with `bun add`. Make sure that `bun.lock` holds it.
- [x] 2.2 In `file_kind.ts`, add the frozen list of the shiki 4.5.0 ids, aliases, and display names. Extract it as text from `bundledLanguagesInfo` in the installed shiki of `/Users/s-ved/repos/inflexa/himmel`. Make sure that the list holds `javascript`, `shellscript`, `kotlin`, and `cmake`.
- [x] 2.3 In `file_kind.ts`, build the Linguist name map and the Linguist extension map on the first lookup. Use the join, the tie rule, and the type-to-kind map of the design. Use the lookup order of the spec. Make sure that each case in `file_kind.test.ts` passes.

## 3. The preview of a `.txt` file

- [x] 3.1 In `src/server/routes/test/fs.test.ts`, add the preview cases for `notes.txt` (`text`), `GSE78220_counts.txt` (`table`), and `counts.tsv` with no separator (`text`). Run the test file and make sure that the `GSE78220_counts.txt` case fails.
- [x] 3.2 In `previewHead` of `src/server/routes/fs.ts`, also admit a name whose extension is `txt`. Make sure that `fs.test.ts`, `artifacts.test.ts`, and `analyses.test.ts` pass.

## 4. Finish

- [x] 4.1 Run `bun run format:file` on the changed source files. Then run `bun run typecheck`, `bun run lint`, `bun run dupes`, and the full `bun run test` one time. Make sure that each command passes.
