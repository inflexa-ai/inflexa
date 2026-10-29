# Proposal

## Why

A client must show each file with no map of its own (issue #780). The server maps few extensions to a kind, and it maps only some extensions to a highlighter language. It has no kind for a protein structure. The ledger rows give no kind, thus Flamme maps the ledger extensions itself.

## What Changes

- One map in the server from an extension or a file name to a kind and a shiki language id. The map covers the code, the workflow, the config, and the data formats of a bioinformatics analysis.
- A new kind `structure` for `pdb`, `ent`, `cif`, `mmcif`, and `bcif`. The kind `figure` adds `jpeg`, `gif`, and `webp`.
- A name entry matches a whole file name, for example `Snakefile`, `Dockerfile`, or `nextflow.config`.
- Each entry of `fs/list` and `fs/search` gets `language`. The text preview takes its language from the map.
- The card preview gets `mediaType`, the `Content-Type` of the read route.
- Each row of `GET {A}/artifacts` gets `kind` and `language`.
- The ledger kind filter of the issue is out of scope. The user removed it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the requirements of the folder list, of the kind map, of the preview, and of the ledger list.

## Impact

- `cli/src/modules/fs/file_kind.ts` holds the map.
- `cli/src/api/fs.ts` and `cli/src/api/artifacts.ts`: new fields, and the kind `structure`.
- `cli/src/server/routes/fs.ts`, `cli/src/server/routes/artifacts.ts`, and `cli/src/server/routes/files.ts` (the media type lookup).
- The tests of these files.
