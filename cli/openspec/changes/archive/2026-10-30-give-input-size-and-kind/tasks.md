# Tasks

## 1. The size and the kind of an input

- [x] 1.1 Add `size: number | null` and `kind: FileKind | null` to `InputView` in `cli/src/api/analyses.ts`, each with a JSDoc that states when it is `null`
- [x] 1.2 In `inputViews` (`cli/src/server/routes/analyses.ts`), read one `statResultAsync` for each located input through `mapBounded`. Set `size` and `kind` as D1 and D2 state
- [x] 1.3 In `cli/src/server/routes/analyses.test.ts`, under "the inputs of an analysis", add a test with real files in a temporary folder: a mapped file, a file whose extension the map does not name, a folder, and a stored input whose path does not exist. Assert `size` and `kind` of each
- [x] 1.4 Add a test that `POST {A}/inputs` gives `size` and `kind` on the added input
- [x] 1.5 Update each other test and fixture that builds an `InputView` literal, so that the typecheck passes
- [x] 1.6 Run `bun run format:file` on the changed source files, `bun run typecheck`, and the changed test files
