# Proposal

## Why

The file route `GET /api/v1/fs/read` gets the type of a file from its extension. The type table has no protein structure format. Thus a `.pdb` file or an mmCIF file comes back as `application/octet-stream`, and a client cannot tell it from other binary data (issue #738). A browser viewer of a structure needs the type to select the file.

## What Changes

- The route gives a type to each structure file: `.pdb`, `.ent`, `.cif`, `.mmcif`, and `.bcif`.
- The text formats get a `text/` type with the UTF-8 charset, thus a browser shows them. `.bcif` is binary, and it gets an `application/` type.
- The report page route uses the same function, thus it also gives these types.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the requirement "The server gives the bytes of a file at an absolute path" names the types of the structure formats.

## Impact

- `cli/src/server/routes/files.ts`: the type lookup of `serveFile`.
- `cli/src/server/routes/files.test.ts`: a test for each structure extension.
- No new dependency. No change to the wire types or to a client.
