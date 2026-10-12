# Proposal

## Why

A browser client cannot give the local server a path, thus it cannot make an analysis or add an input. Each path in a request is an absolute path, for example `folder` of `POST /api/v1/analyses`, and an input can be anywhere on the disk. The TUI reads the disk itself (`src/tui/components/dialog/file_picker.tsx:148`), but a browser cannot read the disk (issue #635).

## What Changes

- New route `GET /api/v1/fs/home`. It gives the home folder of the OS user that runs the server.
- New route `GET /api/v1/fs/list?path=<absolute path>`. It gives the entries of one folder in the list envelope (`entries`), with the paging of the other lists. The response also gives the canonical path of the folder, and if the folder is readable.
- Each entry gives these facts:
  - the name, the absolute path, and the kind: file, folder, or symbolic link
  - for a link: the target, the kind of the target, and if the link is broken
  - the size of a file, the time of the last change, and the mode bits
  - if the server user can read and write the entry, and if the entry is hidden
- The query value `hidden=true` shows the hidden entries. The default hides them, as the TUI picker does.
- The listing gives metadata only, never the content of a file. It has no root limit. Only #636 gives the content of a file, from the readable roots of an analysis.
- A relative path gives 400 `validation_error`. An absent folder gives 404 `not_found`. A folder that the server user cannot read gives 403 `forbidden`, with a message that names the cause.
- One listing module in `src/lib/` reads a folder and resolves the facts of an entry. The route and the TUI picker both call it. The TUI calls it directly, not over HTTP.
- The sort uses the kind from the folder read: folders first, then each other entry, each group in case-insensitive name order. Thus the route takes a `stat` only for the entries of one page.
- **BREAKING** (TUI behavior) A symbolic link to a folder sorts with the files in the TUI picker, because the sort no longer resolves a link. Its row still has the trailing `/`, and enter still opens it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the route groups get the file system group (`/api/v1/fs`). New requirements give the home route and the folder list route, with their entry fields, the sort, the paging, the hidden filter, and the errors.
- `file-picker`: the listing comes from the shared listing module. The sort uses the kind from the folder read, thus a link to a folder sorts with the files and still opens as a folder. The metadata requirement names the shared module, with the same budget of one `stat` for each entry.

## Impact

- Server code: a new route file `src/server/routes/fs.ts`, mounted in `src/server/app.ts` at `/api/v1/fs`. It needs no harness runtime.
- Wire types: a new file `src/api/fs.ts`.
- Shared code: a new listing module in `src/lib/`, and a writability rule beside `isReadableBy` in `src/lib/fs.ts`.
- TUI: `src/tui/components/dialog/file_picker.tsx` uses the listing module in place of its own `readdirSync` and `stat` code. Its presentation (the columns, the ceiling, the footer) stays.
- Tests: a route test for the fs routes, a unit test for the listing module, and the picker render tests.
- No new dependency. No client fetcher, because the TUI calls the listing module directly and a browser calls the routes.
