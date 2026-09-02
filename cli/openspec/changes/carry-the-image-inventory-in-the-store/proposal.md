# Carry the image inventory in the store

## Why

The harness change of the same name moves the image inventory from a text
fragment inside the image to a JSON record at the store root,
`image-packages.json`, which the catalog build packs into the store
artifact. The CLI reads the fragment today with a container run at boot
and after each image pull, and it caches the output per image digest. With
the record in the store, that extraction has no reader, and the download
merge must keep the record fresh across an update.

## What Changes

- The download merge puts `image-packages.json` on the update rule beside
  `deps.json` and the catalog farm. On a plain download the record moves
  in only when the root has none. On `--update` the new record replaces
  the old one whole, because the record describes the image that the new
  catalog was proven beside.
- The container extraction of the fragment and its per-digest cache go
  away: the extraction function, its call after a runtime-image pull, the
  boot seam that resolves it, and the boot warning for a missing fragment.
- The `libsDir` cache directory retires, because the extraction was its
  one consumer.
- The boot binds `imagePackagesFile` to the static path
  `<packageStoreDir>/image-packages.json`, the same way it binds
  `farmLockFile`. The tool reads the file at each call, thus a catalog
  download that lands mid-session reaches the next call.
- The composition field `imagePackagesFile` becomes a plain string, because
  the path is known at boot whether or not the file exists yet.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `package-store-download`: the image record rides the update rule of the
  merge beside the graph and the catalog farm.

## Impact

- `src/modules/libs/store_download.ts` — the record joins the replace rule
  of `mergeStagedRoot`.
- `src/modules/libs/packages.ts` — the extraction function and the image
  path constant leave. The pool inventory reader stays.
- `src/modules/libs/transfers.ts` — the extraction call after a
  runtime-image pull leaves.
- `src/modules/harness/runtime.ts` — the `resolveImagePackages` boot seam,
  its call, and the warning leave. The static path binds in their place.
- `src/modules/harness/run_deps.ts` — `imagePackagesFile` becomes a string.
- `src/lib/env.ts` — `libsDir` and its `envDoc` entry leave.
- Tests: `src/modules/harness/runtime.test.ts` and
  `src/modules/harness/run_deps.test.ts` name the seam and the null field.
- Not affected: the transfer lifecycle, the receipt, the farm resolver, the
  pool inventory, and the sandbox gate.
