# Proposal

## Why

A browser client cannot show a file of an analysis (issue #636). `POST {A}/artifacts/resolve` gives an absolute path, and the TUI opens it with the opener of the operating system. A browser cannot open a disk path. Thus a browser client cannot show a figure, a file card, a chart from a CSV file, or a provenance export.

`POST {A}/artifacts/resolve` also has a gap. It does a test of the form of the path only (`src/server/routes/artifacts.ts:54`), then it joins the path to the workspace root (`src/modules/harness/artifact_open.ts:48-51`). An agent can write a symbolic link in `runs/` to a file outside the workspace, and the route then gives the path of that file.

## What Changes

- New route `GET {A}/files?path=<path>`. It gives the bytes of one file from the readable roots of the analysis:
  - A relative path resolves against the workspace root, and its real path must be inside the real path of the workspace root.
  - An absolute path must have its real path inside the real path of a declared input. The user gave consent for an input when the user declared it.
  - A real path resolves each symbolic link.
  - Each other path gets 403 `forbidden`, also a path that does not exist outside the roots.
- The route streams the body from the open file. It never reads a whole file into memory. Each disk operation runs off the event loop.
- The content type comes from the extension, with `X-Content-Type-Options: nosniff`.
- `Range` gives one part of a file, because a CSV file has no size limit. An unsatisfiable range gets 416 with the new error code `range_not_satisfiable`.
- The route gives an `ETag`. `If-None-Match` with the current tag gives 304, thus a client that reads a file again after a run event gets no bytes for an unchanged file.
- `download=1` adds `Content-Disposition: attachment`.
- A type that a browser runs as a document with script (HTML, XHTML, SVG, XML) gets `Content-Security-Policy: sandbox`. A script in such a file then cannot use the session of the browser on the origin of the server.
- A folder, or a different file that is not a regular file, gets 400 `validation_error`.
- The route accepts the session cookie of the browser sign-in, because an `<img>` cannot send the bearer header. The route is under `/api`, thus the cookie reaches it with no change to the credential check.
- `POST {A}/artifacts/resolve` gets the same real-path test for a `workspace-file` entry. A path whose real path leaves the workspace resolves nowhere, the same as a path with a bad form.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the records group of `{A}` gets the files. The error table gets `range_not_satisfiable` (416). A new requirement gives the file route: the roots, the real-path test, the headers, the range, the tag, the download, the sandbox, and the errors.
- `artifact-open`: a `workspace-file` reference whose real path leaves the workspace resolves nowhere.

## Impact

- Server code: a new route file `src/server/routes/files.ts`, mounted in `src/server/app.ts` after the analysis guard. `src/server/routes/artifacts.ts` gets the real-path test.
- Module code: `src/modules/analysis/boundary.ts` gets the roots of a read and the real-path test. The two routes share the test. The canonical paths of the inputs move from `src/server/routes/analyses.ts` into the analysis module, because a module cannot import a route.
- Wire types: `src/api/common.ts` gets the error code `range_not_satisfiable`.
- Tests: a route test for the file route, and symbolic-link tests for `artifacts/resolve`.
- No new dependency. The content type comes from `hono/utils/mime`, which the installed Hono gives. No client fetcher, because a browser uses the URL.
