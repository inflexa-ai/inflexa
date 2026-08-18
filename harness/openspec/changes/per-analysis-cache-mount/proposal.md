# Per-Analysis Cache Mount

## Why

Every kernel that a sandbox compiles at run time dies with its container. The
sandbox copies the prepared cache to `/tmp`, numba writes each new entry there,
and the container is removed on completion. Thus the catalog workload prepares
about 29 entries one time, and everything outside that set compiles again on
every step, of every run, forever. Nothing accumulates.

A warm at acquisition cannot close this gap. A numba entry keys on the type
signature of a call, and an import gives none. The only workload that is ever
correct is the analysis itself. Thus the cache must grow from real runs, and it
must survive the container.

A shared writable home would open a hole. A `.nbc` file is machine code, and a
load executes it. A sandbox runs agent-generated code, thus a cache that every
analysis writes would let analysis A plant code that analysis B executes. The
cache is per analysis for that reason, and a cache attack stays inside the farm
that made it.

## What Changes

- **BREAKING** — the sandbox mounts a per-analysis cache directory read-write,
  and `seed_caches` copies nothing. The mount replaces the copy to `/tmp`: the
  seed exports `NUMBA_CACHE_DIR` and `MPLCONFIGDIR` at the mounted paths. The
  store and the farm stay read-only.
- The harness declares the cache location beside the farm resolution. The
  embedder resolves it for each analysis, exactly as it resolves the farm. On
  Docker the location is a host path. On Kubernetes it is a subPath under the
  store PVC, mounted read-write.
- The embedder owns the creation and the seed of the cache, exactly as it owns
  the composition of the farm. The harness mounts what the provider names.
- The composed farm stops carrying the two cache links. The mount is what puts
  a cache at the container path, thus the links select nothing.
- The effectiveness check of the build reads the mounted arrangement, because a
  check must exercise the shape that production uses.
- Two sandboxes of one analysis can write one cache at the same time. numba
  loads the index again on each save, thus a racing save can drop an entry, and
  a dropped entry only compiles again. The design accepts that loss.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `lib-store`: the mount contract gains the per-analysis cache mount, and the
  resolver env points the caches at it. The farm loses its cache links.
- `lib-store-build`: the seed of the image exports the mounted paths and copies
  nothing. The effectiveness check reads the mounted arrangement.
- `lib-store-provisioner`: the prepared caches of the catalog stay where they
  are. They become the seed source of each per-analysis cache, and nothing else
  reads them at run time.

## Impact

- `harness/src/sandbox/types.ts` — the cache location beside `FarmResolution`.
- `harness/src/sandbox/mount-plan.ts`, `docker-client.ts`, `k8s-client.ts` —
  the third lib-store mount.
- `images/sandbox-base/inflexa-seed-caches` — export the mounted paths, copy
  nothing.
- `.github/workflows/lib-store-provisioner.yml`,
  `scripts/lib-store-cache-check.py` — the check against the mounted shape.
- The CLI half — the creation, the seed, the permissions, and the removal of
  the cache — is the companion change `per-analysis-warm-caches` in
  `cli/openspec/changes/`.
