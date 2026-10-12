# Design

## Context

- The TUI picker reads the disk in `listDir` (`src/tui/components/dialog/file_picker.tsx:145-174`). It does one `readdirSync` with `withFileTypes`, hides each dot-entry by default, and sorts folders first, then the rest, each group by `localeCompare` with `sensitivity: "base"`.
- Today the picker resolves each symbolic link with a `stat` (`safeSymlinkIsDir`, line 200), thus a link to a folder sorts and opens as a folder. Its row value is the canonical target (`canonicalPath`), because the selection space is canonical.
- At or below `METADATA_ENTRY_CEILING` (2000 raw entries), the picker takes one `stat` for each entry (`entryMeta`, line 186). Above it, the rows carry names only. The fill is synchronous, as the file-picker spec requires.
- `src/lib/fs.ts` has `statResult`, `ProcessIdentity`, `processIdentity()`, and `isReadableBy`. A client (`src/tui/`) can import `src/lib/` (all but `lib/bus.ts`), and so can the server. Thus `src/lib/` is the one layer that both callers can share.
- The routes give errors through `apiError` (`src/server/http.ts:31`), and they page a list with `parsePage` and `listEnvelope` (`http.ts:63-74`). `routes/conversation.ts:270-276` pages an array in memory with `slice`.
- A boolean query value has the `touch` precedent (`routes/analyses.ts:243-246`): `true` or `false`, else 400 `validation_error`. An absolute path has the `cwd` precedent (`analyses.ts:240-242`).

## Goals / Non-Goals

**Goals:**

- One module that reads a folder and gives the facts of an entry, for the route and the TUI.
- A route that takes a `stat` only for the entries of the page that it gives.

**Non-Goals:**

- The content of a file. Issue #636 gives it.
- A root limit, or a check of the path against an analysis.
- A client fetcher in `src/client/`. No command and no TUI view calls the routes.
- A change to the presentation of the picker: the columns, the ceiling, the footer, and the keys stay.

## Decisions

### D1. The listing module: one read function and one entry function

A new file `src/lib/folder_listing.ts` holds the listing. It gives two functions, and each caller uses both:

- `readFolder(path, hidden)` makes the path canonical with `realpathSync`, reads it with one `readdirSync` (`withFileTypes`), drops the hidden entries unless `hidden` is true, and sorts. It takes no `stat` of an entry. It gives the canonical folder path, the sorted entries, and the raw count of the read. Each entry has its name, its absolute path (the canonical folder joined with the name), its kind, and its hidden flag.
- `entryDetails(entry, identity)` gives the facts of one entry from one `stat`, and from one `readlinkSync` for a link. It never fails. A failed `stat` gives `null` facts, and the row stays.

The issue asks for "one function". The two parts stay apart because the callers select different entries for the `stat`. The route selects the entries of one page. The picker selects each entry at or below the ceiling, and only the links above it. One entry point would have to carry both policies. Thus the read, the filter, and the sort are one function, and neither caller copies any part of the listing.

Alternative: `listFolder(path, { hidden, detail })`, where `detail` names a range of the sorted entries. The ceiling rule of the picker uses the raw count of the read, which a caller cannot know before the call. Rejected.

### D2. The kind and the sort come from the folder read

The kind maps from the dirent: a folder is `folder`, a symbolic link is `symlink`, and each other dirent (a file, a FIFO, a socket, a device, an unknown type) is `file`. The sort puts `folder` first, then each other kind, each group in case-insensitive name order. One `Intl.Collator` with `sensitivity: "base"` for the module does the compare, because `localeCompare` with options makes a collator for each call. A tie falls back to a code-unit compare of the two names. Thus the order is the same for each request, and two requests for two pages agree. This applies when two names differ only in case, for example `A.txt` and `a.txt`.

As a result, a link to a folder sorts with the files, in the TUI too. The issue gives the sort to the folder read so that the route takes no `stat` outside its page. The picker keeps the trailing `/` on such a row, and enter still opens it. The picker reads the kind of the target from `entryDetails`.

Alternative: a `stat` for each link before the sort. The route would then take a `stat` outside its page, for each link of the folder. Rejected by the issue.

### D3. The facts of an entry

`entryDetails` gives:

- `size`: the size in bytes for a file, and for a link to a file. It is `null` for a folder, for a link to a folder, and when the `stat` fails. The picker shows no size for a folder.
- `modifiedMs`: the `mtimeMs` of the `stat`. The route gives it as an ISO 8601 string, `modifiedAt`, as the local-server spec requires for a time.
- `mode`: the permission bits, `stats.mode & 0o7777`. It is `null` when the process has no POSIX identity (Windows), because Node makes up the bits there.
- `readable` and `writable`: the verdict of `isReadableBy` and of a new `isWritableBy` in `src/lib/fs.ts`, from the mode bits and the owner ids. They are `null` with no POSIX identity. Both are advisory. They do not see an ACL, a macOS TCC rule, a read-only mount, or a file flag. `isWritableBy` mirrors `isReadableBy`: root writes each entry, the owner needs `0o200`, a member of the group needs `0o020`, and each other user needs `0o002`.
- `link`: `null` for an entry that is not a link. For a link, it gives these facts:
  - `target`: the text of `readlinkSync`, as the link stores it. It can be relative. It is `null` when `readlinkSync` fails.
  - `broken`: true when the `stat` of the target fails with `ENOENT`, `ENOTDIR`, or `ELOOP`.
  - `targetKind`: `folder` or `file` from the `stat` of the target, or `null` when that `stat` fails.

For a link, the `stat` follows the link, thus `size`, `modifiedMs`, `mode`, `readable`, and `writable` describe the target. The picker does the same today. A client that wants to open a link to a folder lists the path of the link. The response then gives the canonical path of the target.

### D4. The folder facts in the response

The list response gives `folder: { path, readable }`. `path` is the canonical path from `readFolder`. `readable` is the verdict of `isReadableBy` on one `stat` of the folder, the same advisory rule as each entry. It is `null` with no POSIX identity, and `null` when that `stat` fails, for example when the folder goes away after the read. The route takes this `stat`, not `readFolder`.

An unreadable folder gets an error (D6), thus a success normally gives `true`. It gives `false` only when an ACL lets the read through and the mode bits deny it.

### D5. The routes

`src/server/routes/fs.ts` gives `fsRoutes()`, which `buildApp` mounts at `/api/v1/fs`. The routes need no harness runtime, thus no `requireRuntime`. The wire types live in `src/api/fs.ts`. `fsRoutes()` reads `processIdentity()` one time, because a process cannot change its own ids.

- `GET /home` gives `{ path }`, from `os.homedir()`.
- `GET /list` reads `path`, `hidden`, `page`, and `perPage` from the query. It checks `path` and `hidden` (D6), calls `holdConnection(c)`, calls `readFolder`, slices the page from the sorted entries, and calls `entryDetails` for each entry of the slice only. The body is `listEnvelope("entries", items, total, page)` with `folder` added. `total` counts the entries after the hidden filter.

`holdConnection` obeys the local-server rule for a route with no body that can work for more than 10 s. A read on a slow mount can.

The wire types in `src/api/fs.ts` are these. The JSDoc of each field is left out here.

```ts
export type HomeFolder = { path: string };

export type FolderEntryKind = "file" | "folder" | "symlink";

export type FolderEntryLink = {
    target: string | null;
    broken: boolean;
    targetKind: "file" | "folder" | null;
};

export type FolderEntryView = {
    name: string;
    path: string;
    kind: FolderEntryKind;
    link: FolderEntryLink | null;
    size: number | null;
    modifiedAt: string | null;
    mode: number | null;
    readable: boolean | null;
    writable: boolean | null;
    hidden: boolean;
};

export type FolderFacts = { path: string; readable: boolean | null };

export type FolderList = ListEnvelope<"entries", FolderEntryView> & { folder: FolderFacts };
```

Each fact that can be absent is `null`, never an absent key. Thus a client reads one shape for each entry. `symlink` is the literal for a symbolic link, the name that the dirent and `node:fs` use.

The `path` of a query must be absolute. The route makes it normal with `resolve` before the read, thus a `..` segment does not reach `realpathSync` as text.

### D6. The errors

| Condition | Response |
|-|-|
| `path` is absent, is not absolute, or holds a NUL byte | 400 `validation_error`, `details.fieldErrors.path` |
| `hidden` is present and is not `true` or `false` | 400 `validation_error`, `details.fieldErrors.hidden` |
| `realpathSync` or `readdirSync` fails with `ENOENT` | 404 `not_found` |
| `readdirSync` fails with `ENOTDIR` (the path is a file) | 400 `validation_error`, `details.fieldErrors.path` |
| each other failure of the read, for example `EACCES` or `EPERM` | 403 `forbidden`, with the cause in the message and the error code in `details.code` |

Each `validation_error` carries the flatten shape `{ formErrors: [], fieldErrors: { <field>: [<reason>] } }` in `details`, as the embedding check of `routes/machine.ts` does. The local-server spec requires the zod flatten output for this code, and `z.flattenError` gives both keys. `node:fs` refuses a path with a NUL byte with `ERR_INVALID_ARG_VALUE`, which is a fault of the request, thus the route refuses it before the read.

`readFolder` gives a discriminated union: `absent`, `not_folder`, and `unreadable`, each with the path and the cause. The route maps each type to one row of the table. The picker shows the message of the cause as its empty-state line, as it does today.

The issue asks for an error that names the cause, thus each other failure gets 403 with the cause text, not a 500 with a generic text. The client can do the same thing in each case: it goes to a different folder. `forbidden` already exists for the Host and Origin check. A client tells the two apart by `details.code`.

Alternative: a new code, for example `unreadable`. It changes `ApiErrorCode`, `API_ERROR_STATUS`, and the error table of the spec for one route. Rejected.

### D7. The picker on the listing module

`listDir` of the picker keeps its signature and its `Listing` result. It calls `readFolder` with `hidden = !hideHidden`. It sets `withMetadata` from the raw count, as today. At or below the ceiling, it calls `entryDetails` for each entry and makes `RowMeta` from the facts. Above the ceiling, it calls `entryDetails` only for each link, to read `targetKind`, and the rows carry no metadata. A row of a link keeps the canonical target as its value (`canonicalPath(entry.path)`). The row is a folder row when its kind is `folder`, or when it is a link whose `targetKind` is `folder`. `COLUMN_TIME`, `modeTriple`, `entryHint`, and the footer stay in the picker. The fill stays synchronous.

### D8. The listing is synchronous on the server

The route calls the synchronous listing on the event loop: one `realpathSync`, one `readdirSync`, one `stat` of the folder, and at most `MAX_PER_PAGE` (200) `stat` calls with a `readlinkSync` for each link. The picker needs the synchronous form, and a second, asynchronous copy of the module would split the one listing.

## Risks / Trade-offs

- [A read of a folder on a hung mount stops each other request of the server] → The page bounds the `stat` calls at 200. No mitigation for a hung mount. An asynchronous read would need a second listing.
- [Each page reads and sorts the whole folder, because the sort comes before the slice] → No bound is possible with a global sort. The cost is one `readdirSync` and a sort of the names, with no `stat`. The picker already reads each name of a folder.
- [A link to a folder moves from the folder group to the file group in the TUI] → The row keeps its `/` and still opens. The file-picker spec gets the new order.
- [`readable`, `writable`, and `broken` are advisory. An ACL, a TCC rule, or a read-only mount can make them wrong] → The same accepted imprecision as `isReadableBy`. The open of a file stays the authoritative test.
- [The paging is not a snapshot. A change of the folder between two page requests can move an entry across a page edge] → The same as each other list of the server. `total` comes from the read of each request.
