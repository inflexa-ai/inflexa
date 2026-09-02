## Context

The image bakes two package tracks that the store cannot hold: the bioconda
tools at `/opt/conda` and the Node packages at `/opt/node`. The manifest
names both: `system_tools:` at `images/package-store/manifest.yaml:637`
and `node:` at `:619`. Each builder stage installs its track from the
manifest and runs a load check. The conda check at
`images/sandbox-base/Dockerfile:112-127` probes each binary on `PATH`,
captures `--version` at line 118, and writes only the names. The node
check in `images/sandbox-base/scripts/node-load-check.js` writes only the
names. The runtime stage joins the two text fragments at `Dockerfile:443-444`
into `/opt/inflexa/image-packages.txt`.

The harness reads the fragment as a host path. The default is
`/opt/inflexa/image-packages.txt`
(`src/tools/sandbox/list-available-packages.ts:46`), a path that exists
only inside the image. The tool reads the file at each call (`:350-352`)
and merges nothing when the read fails. The farm lock default, by
contrast, is the container mountpoint
(`DEFAULT_FARM_LOCK_FILES` at `:43`, from `LIBS_CONTAINER_PATH` in
`src/sandbox/mount-plan.ts:41`). The interface doc of
`EnvironmentStorePaths` (`src/config/environment-stores.ts:23-33`) gives
the rule: an omitted path falls back to the container mountpoint, each
consumer stats the root before it reports, and absence is never reported
as presence.

The catalog build workflow builds its own `sandbox-base` for the run
(`.github/workflows/package-store-build.yml:213-217`), runs the load check
inside that image against the store volume (`:341-345`), and packs each
root entry of the store into the base layer (`:498-501`). Both build
workflows mint the version as the date and the short sha
(`package-store-build.yml:75`, `sandbox-images-build.yml:72`).

The stakeholders are the harness, the CLI, and the managed embedder Cortex.
The CLI extracts the fragment with a container run today. Cortex cannot,
because its pod has no engine.

## Goals / Non-Goals

**Goals:**

- Each reader of the store gets the inventory of the image, with no engine,
  no registry client, and no path outside the store.
- The record carries the image identity and the versions, thus the rows
  render `name==version`, and a later change can compare the record
  against the configured image.
- The image keeps its own copy, thus the image describes itself and the
  store carries a copy of that description.

**Non-Goals:**

- No comparison of the recorded image against the running image. The data
  lands now, and the check is a later change.
- No pinned catalog tag for `store download` (inflexa#498).
- No change to the mount plan, the sandbox backends, the farm lock, or the
  pool inventory.
- No CLI code in this change. The twin change in the CLI tree carries the
  download merge rule and the removal of the container extraction.

## Decisions

**1. The store carries a copy of the image record.** The catalog build
copies `/opt/inflexa/image-packages.json` out of the image that it built
for the run into the store root, between the load check and the pack. The
pack needs no change, because the base layer holds each root entry.

The copy can drift from the running image: the chart can override the
runtime tag, and `latest-<arch>` moves. The trade is accepted, because
the record names its image, and the pair of tags already shares one
version string. The alternatives were rejected:

- An OCI label. A Dockerfile `LABEL` takes a literal or a build arg, and
  the fragment is made inside the build. Thus only the workflow can set
  the label, after a first build. The harness would then need a registry
  client for Kubernetes, and the Cortex pod would need egress to the
  registry.
- A read over the exec channel of the first sandbox. The conversation
  agent has no inventory until a sandbox ran, and the cache has no
  durable home.

**2. The record is JSON with a schema number, and its keys mirror the
manifest.** The shape:

```json
{
  "schema": 1,
  "image": { "repository": "ghcr.io/inflexa-ai/sandbox-base", "version": "20260901-3031713", "arch": "amd64" },
  "runtimes": { "python": "3.12.3", "r": "4.6.0", "node": "24.8.0" },
  "system_tools": [ { "name": "samtools", "version": "1.22.1" }, { "name": "eagle2", "version": "2.4.1", "executable": "eagle" } ],
  "node": [ { "name": "echarts", "version": "6.0.0" } ]
}
```

The lock sets the convention (`FarmLockSchema`, `src/sandbox/farm.ts:46`):
a `schema` literal, additive fields pass through, and a breaking change
moves the number. The keys `system_tools` and `node` are the manifest
keys. `executable` exists because a conda package name and its binary can
differ, and the manifest `binaries:` map holds the exceptions. `runtimes`
records the interpreter versions, because the lock records
`languages.python.version` and `languages.r.version`, and a reader with
no container can then compare the two records later.

The alternatives were rejected. The text format with an identity comment
carries no versions and no structure. The farm lock requires `store_dir`
and `hash` for each package (`farm.ts:29-38`), which an image tool does
not have, and the tool reads the lock of the analysis farm, which the CLI
composer writes without image tracks.

**3. The image writes its own record, and the build copies it verbatim.**
The two builder stages emit JSON fragments with versions. The runtime
stage assembles the record with the identity from the `IMAGE_VERSION` and
`TARGETARCH` build args and a repository constant. The assembly is the
last write of the runtime stage, because the version changes at each
build, and a late layer keeps the cache of the large copies above it.
The workflow then copies one file and assembles nothing, thus one writer
owns the shape.

The conda check reads the version of each tool from `micromamba list --json`
over the prefix, keyed on the package name, and the probe of the binary
name decides presence, as today. The node check reads
`node_modules/<name>/package.json` for each package that loaded. The
runtime stage reads the three runtime versions from `python3 --version`,
`R --version`, and `node --version`.

**4. The default path is the container mountpoint, and the explicit path
stays as the override.** `DEFAULT_IMAGE_PACKAGES_FILE` becomes
`${LIBS_CONTAINER_PATH}/image-packages.json`. Cortex on Kubernetes mounts
the libs volume at `/mnt/libs` on its own pod, thus the default hits with
no configuration. A host that reads the store elsewhere sets
`imagePackagesFile`, the same as `farmLockFile`.

The tool reads the record at each call, not one time at boot. A catalog
download can land while the process runs, and a boot-time read would hold
the cold state for the life of the process. The farm lock follows the
same rule for the same reason.

**5. The rows render the executable name.** An agent invokes the binary,
not the conda package. Thus a `system_tools` row renders
`<executable>==<version>`, and `executable` defaults to `name`. The
section titles stay `System tools (CLI)` and `Node (npm)`, because the
`language` filter keys on them (`LANGUAGE_MATCHERS` at
`list-available-packages.ts:137`).

**6. An absent or invalid record merges nothing.** The record is an
enrichment of the farm inventory, and the farm inventory stays whole
without it. A store from before this change has no record, and the report
then carries the farm tracks alone, which is what Cortex gets today. The
zod schema is the one definition of the shape, the same rule as the lock.

**7. The text format retires with no compatibility path.** After this
change and the CLI twin, no reader of the text fragment remains. The
readers are the harness tool, the acceptance validator
(`scripts/package-store-validate/validate.py`), and the CLI extraction.
`parsePackagesFile` and its tests leave the harness, and the validator
reads the record of the image under test, because the advertised set of
the acceptance must include the image tracks.

## Risks / Trade-offs

- [The store record and the running image differ] → The record names
  its image version and arch. The comparison is a later change, and the
  tag pairing is inflexa#498.
- [A CLI store keeps an old record after `--update`] → The download merge
  moves a root entry only when it is absent. The CLI twin change puts the
  record on the update rule beside `deps.json` and the catalog farm.
- [An invalid record degrades in silence] → The tool has no logger, and
  the farm inventory stays whole. The trade is accepted for an enrichment.
- [The two workflows build at different commits] → Both mint the version
  from the date and the sha, thus a same-commit pair is byte-identical in
  content, and a different pair is visible in the record.
- [The record is per arch] → Correct by construction. The store artifact
  and the image are per arch, and `plink2` and `eagle2` are amd64-only.

## Migration Plan

A mixed state degrades to a report without the image tracks, and never to
an error:

- A new harness beside an old store finds no record at the store root, and
  it merges nothing.
- An old harness beside a new image finds no text fragment, and it merges
  nothing.
- A new store beside an old harness has a record that nothing reads, and
  the farm tracks report as before.

## Open Questions

_None._
