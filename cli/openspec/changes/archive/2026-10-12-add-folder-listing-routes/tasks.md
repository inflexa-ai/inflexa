# Tasks

## 1. The listing module

- [x] 1.1 Add `isWritableBy(stats, identity)` beside `isReadableBy` in `src/lib/fs.ts` (design D3): root writes each entry, then the owner bit `0o200`, the group bit `0o020` (the effective gid or a supplementary group), and the other bit `0o002`. Add its cases to `src/lib/fs.test.ts`, and make sure that the tests pass.
- [x] 1.2 Add `src/lib/folder_listing.ts` with `readFolder(path, hidden)` and `entryDetails(entry, identity)` (design D1, D2, D3). `readFolder` gives a `Result` whose error is the union `absent`, `not_folder`, and `unreadable`, each with the path and the cause (design D6). Wrap each throwing `node:fs` call in a `Result` at this boundary. Use one module `Intl.Collator` for the sort, with a code-unit tiebreak.
- [x] 1.3 Add `src/lib/folder_listing.test.ts` with real temporary folders. Cover each of these:
  - the sort, folders first, with a link to a folder in the second group
  - the tiebreak for two names that differ only in case
  - the hidden filter, and the raw count of the read
  - the canonical folder path through a link, and the entry paths under it
  - each error type: `absent`, `not_folder`, and `unreadable` (mode 000, skipped as root)
  - a file, a folder, a link to a folder, and a broken link in `entryDetails`
  - an entry that disappears before its `stat`, which gives `null` facts
  - a `null` identity, which gives `null` for `mode`, `readable`, and `writable`

  Make sure that the tests pass.

## 2. The routes

- [x] 2.1 Add the wire types of design D5 in `src/api/fs.ts`, with a JSDoc block on each type and field. Make sure that `bun run typecheck` passes.
- [x] 2.2 Add `fsRoutes()` in `src/server/routes/fs.ts` with `GET /home` and `GET /list` (design D5, D6), and mount it in `src/server/app.ts` at `/api/v1/fs`. The list route validates `path` and `hidden` with the flatten shape in `details`, and calls `holdConnection(c)`. It reads the folder, slices the page with `parsePage`, and calls `entryDetails` for the slice only. It takes one `stat` of the folder for `folder.readable`, which is `null` when that `stat` fails. It reads `processIdentity()` one time in `fsRoutes()`.
- [x] 2.3 Add `src/server/routes/fs.test.ts` with a test for each scenario of the local-server requirements "The server gives the home folder and the entries of a folder", "The folder list refuses a bad path with a named error", and "The file system routes give metadata only". Include a bad `hidden` value. For a page of a large folder, count the calls of `entryDetails`. Make sure that only the entries of the page get a call. Use a spy on the module export, or an `entryDetails` option of the route, as `MachineRouteOpts` does in `routes/machine.ts`. Make sure that the tests pass.
- [x] 2.4 Add a test in `src/server/app.test.ts` that `GET /api/v1/fs/list` with no credential gets 401 and with the bearer token gets 200 through `buildApp`. Make sure that the tests of `app.test.ts` pass.

## 3. The picker

- [x] 3.1 Change `listDir` in `src/tui/components/dialog/file_picker.tsx` to use `readFolder` and `entryDetails` (design D7). Remove its own `readdirSync`, `entryMeta`, and `safeSymlinkIsDir` code. Keep `Listing`, the ceiling flag from the raw count, the canonical target as the value of a link row, and the synchronous fill.
- [x] 3.2 Add a render test in `src/tui/components/dialog/file_picker.render.test.tsx` for the file-picker scenario "A symlink to a folder sorts with the files and still opens". Make sure that each test of the file stays green.

## 4. Verification

- [x] 4.1 Run `bun run format:file` on the changed files of `src/`. Then run `bun run typecheck`, `bun run lint`, and the changed test files. Make sure that each one passes.
- [x] 4.2 Run the full suite of cli one time with `bun run test`, and make sure that it passes.
