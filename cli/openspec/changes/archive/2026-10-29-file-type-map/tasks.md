# Tasks

## 1. The map

- [x] 1.1 In `src/modules/fs/file_kind.test.ts`, give each key of the spec table its kind and its language. Add the name keys, the `gz` cases, and the unknown names. Make sure that the tests fail before the change.
- [x] 1.2 In `src/modules/fs/file_kind.ts`, replace the kind table with the one table of the spec, and add `languageOf`. Add `structure` to `FILE_KINDS` in `src/api/fs.ts`. Make sure that `file_kind.test.ts` passes.

## 2. The routes

- [x] 2.1 In `src/server/routes/fs.test.ts`, add a list test that gets the kind and the language of each key of the table. Add a test for the language of a folder, and a card test for a PDF file. Make sure that they fail before the change.
- [x] 2.2 In `src/server/routes/artifacts.test.ts`, add a test that gets the kind and the language of a row for each key of the table. Make sure that it fails before the change.
- [x] 2.3 Add `language` to `FolderEntryView`, `mediaType` to `CardPreview`, and `kind` and `language` to `ArtifactEntry`.
- [x] 2.4 In `src/server/routes/fs.ts`, give `language` on each entry and in the text preview, and `mediaType` on the card. Remove `LANGUAGE_BY_EXTENSION`. Export `contentTypeOf` from `src/server/routes/files.ts`.
- [x] 2.5 In `src/server/routes/artifacts.ts`, give `kind` and `language` on each row. Make sure that the route tests pass.
- [x] 2.6 Run `bun run format:file` on the changed files, then `bun run typecheck` and `bun run lint`, and make sure that each passes.
