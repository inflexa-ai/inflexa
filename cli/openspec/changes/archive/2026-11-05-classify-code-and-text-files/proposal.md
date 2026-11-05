# Proposal

## Why

The kind map of the file system routes has no row for JavaScript or TypeScript (issue #830). It also gives the kind `table` to each `.txt` file. Thus Flamme shows the scripts of `run_script` as plain text, and it shows a text note as a table. The map also knows only a fixed list of extensions. A file in a language that the highlighter of Flamme supports, but that the map does not list, shows as plain text.

## What Changes

- The map gets the rows `code`/`javascript` (`js`, `mjs`, `cjs`), `code`/`jsx` (`jsx`), `code`/`typescript` (`ts`, `mts`, `cts`), and `code`/`tsx` (`tsx`).
- `txt` gets the kind `doc` and the language `text`. The preview reads a `.txt` file as a file of the kind `table`. Thus a head with a tab or a comma in its full header record gives the `table` member.
- For a file name that the map does not know, the server uses the language data of GitHub Linguist (the `linguist-languages` package). It takes a Linguist language from the whole file name, and then from the extension. It keeps only a language that has a shiki language id, and it gives a kind from the type of the Linguist language.
- The cli holds a frozen list of the language ids and the aliases of shiki 4.5.0, the version of the highlighter of Flamme.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the requirement of the kind map, and the `table` member of the preview requirement.

## Impact

- `cli/src/modules/fs/file_kind.ts` holds the map and the Linguist fallback.
- `cli/src/server/routes/fs.ts`: the `table` gate of the preview.
- `cli/package.json`: the new dependency `linguist-languages` 9.5.0. The user approved it.
- The tests: `src/modules/fs/test/file_kind.test.ts`, the oracle `src/test_support/file_types.ts`, and `src/server/routes/test/fs.test.ts`.
- The TUI does not use a file system route, thus it does not change.
