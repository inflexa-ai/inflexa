## Context

The download merge (`mergeStagedRoot`, `src/modules/libs/store_download.ts:914-960`)
removes nothing of the user. `store/` and `farms/` merge one level deeper.
`deps.json` rides the update rule through `mergeStoreGraph` (`:883-897`):
it moves in when the root has none, and it replaces the old graph whole on
`--update`. The catalog farm rides the same rule through `mergeFarms`. Any
other root entry moves in only when it is absent (`:947-948`). A record
that the catalog build adds at the store root thus lands on the first
download and never refreshes after that.

The CLI reads the image inventory fragment today with a container run.
`imagePackagesFile` in `src/modules/libs/packages.ts:43-77` inspects the
local image digest, runs the image with `cat` as the entrypoint, and caches
the output under `env.libsDir`, keyed on the digest. The boot calls it
through the `resolveImagePackages` seam (`src/modules/harness/runtime.ts:390`,
`:439`, `:761-764`), and the transfer child calls it after each
runtime-image pull (`src/modules/libs/transfers.ts:455`). The composition
carries the path as `imagePackagesFile: string | null`
(`src/modules/harness/run_deps.ts:116`). `libsDir` (`src/lib/env.ts:281`)
exists for that cache alone, and its documentation says so (`:289-291`).

The harness change of the same name moves the default read path of the tool
to `/mnt/libs/image-packages.json`, and the CLI bind-mounts
`env.packageStoreDir` at `/mnt/libs`. Thus the host path of the record is
`<packageStoreDir>/image-packages.json`.

## Goals / Non-Goals

**Goals:**

- A catalog update refreshes the image record with the graph and the
  catalog farm.
- The CLI reads the record from the store root, and no container runs to
  learn the inventory.

**Non-Goals:**

- No change to the shape of the record. The harness owns the schema.
- No boot-time check that the record exists. The tool reports absence at
  read time, and a fresh setup has no store yet.
- No change to the transfer lifecycle, the receipt, or the `up_to_date`
  path, which writes nothing.

## Decisions

**1. The record rides the update rule of the graph.** The graph, the
catalog farm, and the image record describe one build: the resolved set,
its template, and the image that the set was proven inside. They move
together. The merge treats `image-packages.json` the same as `deps.json`:
absent moves in, present stays on a plain download, and present is
replaced whole under `--update`. The same helper serves both, thus one
place holds the rule.

The alternative, the plain add-only rule for a root entry, was rejected,
because the first update would leave a record of an older image beside
a newer catalog.

**2. The extraction leaves with its cache.** No reader of the text
fragment remains after the harness change, and the record in the store
serves the same purpose with no engine. The function, the transfer hook,
the boot seam, and the boot warning go. `libsDir` goes with them, because
the cache was its one consumer, and a directory with no writer and no
reader is a false promise in `envDoc`.

**3. The path is static, and the boot does not stat it.** The boot binds
`imagePackagesFile` to `join(env.packageStoreDir, "image-packages.json")`
the same way it binds `farmLockFile` (`runtime.ts:770`). The tool reads
the file at each call. A fresh setup starts the catalog transfer detached,
thus a boot-time warning would fire on every first run and name a normal
state. The composition field becomes a plain string, because the path is
known whether or not the file exists.

## Risks / Trade-offs

- [A store from before the harness change holds no record] → The tool
  merges nothing, and the report carries the farm tracks alone. The next
  `--update` lands the record with the new graph.
- [The retired cache directory stays on disk] → Old text fragments under
  the former `libsDir` are a few hundred bytes, and no cleanup runs. A user
  can remove the directory by hand, and nothing reads it.
- [A user removes the record by hand] → The plain download moves it back
  in only when the tag moved and `--update` runs. Accepted: the record is
  an enrichment, and the farm inventory stays whole.
- [The transfer child no longer touches the image after a pull] → Nothing
  else depended on that touch. The pull still verifies and settles the
  same way.
