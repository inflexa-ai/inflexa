# Design

## Context

`serveHandle` in `src/server/routes/files.ts` sets the type with `getMimeType(name)` from `hono/utils/mime`. The default table of hono has no structure format. `getMimeType` takes a second argument, a table of extension to type, and it uses that table in place of its default. The module also exports the default table as `mimes`.

## Goals / Non-Goals

**Goals:**

- Give the type that the spec delta names to each structure extension.

**Non-Goals:**

- A structure kind in the preview of `GET /api/v1/fs/preview`, or in `src/modules/fs/file_kind.ts`.
- A change to the structure formats that the harness admits.

## Decisions

### The types of the formats

The user selected these types:

- `.pdb`, `.ent`: `text/x-pdb; charset=utf-8`
- `.cif`, `.mmcif`: `text/x-mmcif; charset=utf-8`
- `.bcif`: `application/x-bcif`

A `text/` type lets a browser show a text format under `nosniff`. The subtype tells a structure from plain text. The rejected alternatives:

- `text/plain` for each text format. A client then cannot tell a structure from a `.txt` file by the type.
- The `chemical/x-pdb` and `chemical/x-mmcif` names. They are not `text/` types, thus a browser downloads the file.

### One extended table

A module constant merges the hono table with the structure entries, and `getMimeType` gets that constant. The lookup then stays one call. A separate lookup before or after `getMimeType` gives the same result with more code.

The structure entries come after the hono entries in the merge. Thus a structure entry wins if a later hono version adds one of these extensions.

## Risks / Trade-offs

- [A browser can download an unknown `text/x-` subtype and not show it.] → A viewer such as Mol* reads the bytes with a fetch. The viewer does not use the inline display.
- [A small-molecule crystallographic `.cif` file also gets `text/x-mmcif`.] → The extension cannot tell the two dialects apart. The issue asks for the mmCIF type.
