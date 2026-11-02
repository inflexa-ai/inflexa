# Proposal

## Why

The Data page of a client cannot show the size and the kind of each input of an analysis (issue #784 and its comment). `GET {A}/inputs` gives no size and no kind. Thus a client reads the inputs place of `GET /api/v1/fs/places`, and that place holds only the first 200 inputs. An input after the first 200 shows no size and the plain file icon.

## What Changes

- Each `InputView` gets `size: number | null`. `size` is the byte size of a file from one `stat` that follows links. It is `null` for a folder and for a path that the server cannot read.
- Each `InputView` gets `kind: FileKind | null`, from the one map of the extensions that the file system routes use. It is `null` for a folder and for an extension that the map does not name.
- The server reads the two values in one `stat` for each input, through a queue of fixed width. Thus the cost of a page stays in the limit of `perPage`.
- `InputView` is the one input shape of the API. Thus the responses of `POST {A}/inputs`, `PUT {A}/inputs`, and `POST {A}/inputs/remove` also carry the two fields.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: a new requirement "An input of an analysis gives its size and its kind".

## Impact

- `cli/src/api/analyses.ts`: two fields on `InputView`.
- `cli/src/server/routes/analyses.ts`: the `stat` and the kind in `inputViews`.
- `cli/src/server/routes/analyses.test.ts`.
- No harness change, and no change to the places route.
