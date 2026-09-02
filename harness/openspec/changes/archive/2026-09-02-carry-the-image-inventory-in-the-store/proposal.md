# Carry the image inventory in the store

## Why

The tool `list_available_packages` merges the tools that the image bakes
into its report, from a fragment that exists only inside the image, at
`/opt/inflexa/image-packages.txt`. A host with a container engine extracts
the fragment with a container run. The managed embedder has no engine, thus
its agents never learn that the image holds samtools, bcftools, bedtools,
tabix, vcftools, mageck, cellsnp-lite, and echarts. The catalog build
already builds the image, and it already packs each root entry of the store.
Thus the store can carry the inventory of the image that it was proven
beside, and each reader of the store gets the inventory with no engine, no
registry, and no path outside the store.

## What Changes

- The image describes itself in one JSON record at
  `/opt/inflexa/image-packages.json`. The record carries a schema number,
  the image identity (the repository, the version, the arch), the runtime
  versions, and the two image tracks `system_tools` and `node` with the
  version of each entry. The text fragment `image-packages.txt` and the two
  per-track text fragments retire. **BREAKING** for a reader of the text
  fragment.
- The two builder stages record the version of each tool and each package
  that passed the load check.
- The image build takes an `IMAGE_VERSION` build arg beside `TARGETARCH`.
  Both build workflows pass the version that they tag with.
- The catalog build copies the record out of the `sandbox-base` image that
  it built for the run into the store root, as `image-packages.json`,
  between the load check and the pack. The pack carries it in the base
  layer as a root entry, with no change to the pack.
- `list_available_packages` reads the record from the store root. The
  default path is the container mountpoint `/mnt/libs/image-packages.json`,
  with the same absence rule as the farm lock default. A zod schema
  validates the record. Each image row renders `name==version`. An absent
  or invalid record merges nothing. The text section parser leaves the
  harness.
- `EnvironmentStorePaths.imagePackagesFile` keeps its meaning as the
  explicit override. Its documentation names the store root.
- Deferred: the comparison of the recorded image against the configured
  image, and the pinned catalog tag of `store download` (inflexa#498).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `sandbox-image-catalog`: the baked inventory is the JSON record with the
  image identity and the versions, not the text fragment. The record shape
  is the contract between the image and the harness.
- `package-store-build`: the catalog build copies the image record into the
  store root before the pack, and the base layer carries it. The record
  names the version and the arch of the image that the build proved the
  store with.
- `package-store`: the discovery tool reads the image record from the store
  root, with the container mountpoint as the default path. The rows carry
  versions. An absent record merges nothing.

## Impact

- `images/sandbox-base/Dockerfile`, `images/sandbox-base/scripts/` — the
  two JSON fragments with versions, the assembly of the record, the
  `IMAGE_VERSION` build arg, and the removal of the text fragments. The
  script `conda-binaries.py` leaves, because the conda load check holds
  its probe-name rule and nothing else calls it.
- `scripts/package-store-validate/validate.py` — the acceptance validator
  reads the image record in place of the text fragment, thus the image
  tracks stay inside the advertised-loadable invariant.
- `.github/workflows/sandbox-images-build.yml` and
  `.github/workflows/package-store-build.yml` — the build arg, and the copy
  step between the load check and the pack.
- `harness/src/tools/sandbox/list-available-packages.ts` — the default
  path, the schema validation, and the section render with versions.
- `harness/src/sandbox/image-packages.ts` — the zod schema of the record,
  a sibling of the farm lock schema.
- `harness/src/config/environment-stores.ts` — the documentation of
  `imagePackagesFile`.
- Documents: `images/sandbox-base/README.md` and `images/README.md` name
  the record in place of the text fragment.
- Outside this tree, in a twin change of the CLI: the download merge puts
  the record on the update rule beside the graph, the container extraction
  of the fragment and its cache go away, and the path derives from the
  store root. Cortex on Docker adds one line beside `farmLockFile`. Cortex
  on Kubernetes changes nothing.
- Not affected: the mount plan, the two sandbox backends, the farm lock, the
  pool inventory, and the description of the tool.
