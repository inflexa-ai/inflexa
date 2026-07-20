# Describe reference artifacts so consumers stop encoding paths

## Why

The catalog says where to fetch a file and nothing about what the file holds.
That silence has a cost: a consumer that wants "a TF-target regulon network"
cannot recognise one from the catalog, so it encodes the install layout instead
— `managed/{id}/{version}/{artifact.path}` plus a filename — and the layout, an
installer detail, becomes a de-facto interface.

Content that encodes it then rots invisibly. Skills read reference data from a
`{category}/processed/{file}` tree no installer has ever produced, called
`read_parquet` on a catalog holding zero Parquet, and reached for MSigDB
collections that are not published. None of that is typecheckable: it surfaces
as a failed analysis, not a failed build.

The fix is to make the catalog say what each file *is*. Once an artifact
declares its format and its internal shape, and a dataset declares its organism,
`list_available_refs` can answer "what do I need" instead of "what is in this
directory" — and nothing downstream needs a path to find data.

Organism is called out separately because it is the axis a wrong choice is
silently wrong on. A human regulon set applied to mouse counts does not error;
it returns plausible numbers that mean nothing.

## What Changes

- Artifacts gain required `format` (logical, compression-independent — a
  `.txt.gz` mapping table is `tsv`) and `contents` (key columns, identifier
  space — the shape a caller must know to use the file).
- Datasets gain optional `organism`, omitted for multi-species sources.
- The integrity ban is unchanged and still explicit: no size, no digest, no
  integrity class. Descriptive fields are not integrity fields — they cost no
  maintenance, are not derived from bytes, and cannot go stale against a
  rebuilt upstream.
- `list_available_refs` joins these onto scanned entries and renders them, so
  format and shape reach the model rather than sitting in structured metadata.

## Impact

- Adding a source is no longer only a URL; it also requires describing the file.
  That is the deliberate trade — an undescribed dataset is undiscoverable.
- Embedders reading the catalog see additional fields; no field is removed or
  renamed, so existing readers are unaffected.
