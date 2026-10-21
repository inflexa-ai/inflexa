# Proposal

## Why

The web client Flamme filters the runs and the artifacts of an analysis on the client, because the routes cannot filter them. Three GitHub issues name the gaps:

- #692: `GET {A}/runs` has no text search (`src/server/routes/runs.ts:220-229`). The run picker of Flamme loads pages of 100 runs and filters only the loaded runs. Thus a person must load more pages to find an old run by its title.
- #694: `GET {A}/artifacts` has no filter by extension and no count of each kind of file (`src/server/routes/artifacts.ts:63-86`). Flamme reads up to 2,000 rows of a run to count its figures and its tables. A larger run shows each count with "+".
- #695: `GET {A}/artifacts` finds a file only by a part of its path. A link of Flamme to a file reads up to 10 pages of `q=<path>` to find the run of the file.

The harness change `filter-the-run-and-artifact-reads` gives the filtered reads. This companion change connects them to the routes.

## What Changes

- `GET {A}/runs` takes `q`. It gives only the runs whose run id or plan title holds the text, with no regard to case. `q` combines with `active` and `threadId`. The order and the pages do not change, and `total` counts the runs that `q` selects.
- `GET {A}/artifacts` takes `path`, which selects the row whose path is equal to the value.
- `GET {A}/artifacts` takes `extension`, a list of extensions with a comma between them. It selects the rows whose path has one of these extensions, with no regard to case.
- `GET {A}/artifacts` gives `extensionCounts`: the count of the selected rows for each extension, and for the rows with no extension. A client maps the extensions to its kinds of file, for example figure and table.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the run list takes a text filter. The artifact list takes the exact-path filter and the extension filter, and it gives the count of each extension.

## Impact

- cli code: `src/server/http.ts`, `src/server/routes/runs.ts`, `src/server/routes/artifacts.ts`, `src/api/runs.ts`, `src/api/artifacts.ts`, and the tests of the two route files.
- The harness: the routes use the reads of the harness change. Thus `bun run harness:local` comes before the typecheck and the tests.
- No client fetcher. The consumer of the new values is the web client.
