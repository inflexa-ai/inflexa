# Per-Analysis Warm Caches

## Why

Each kernel that a sandbox compiles dies with its container, because the seed
copies the prepared cache to `/tmp`. The harness companion change
`per-analysis-cache-mount` replaces the copy with a read-write mount of a
per-analysis cache. This change is the embedder half: who makes the cache, how
it is seeded, who can write it, and when it dies.

## What Changes

- The CLI makes `farm-caches/<analysisId>` under the store root, beside
  `farms/`. The creation happens at sandbox creation, beside the step tree,
  because that code holds the engine fact that decides the permissions.
- The seed rule: hardlink the numba entries of the catalog, and copy the
  matplotlib directory. A hardlink costs no bytes, and numba writes only
  through `os.replace`, thus a run never touches a catalog inode. matplotlib
  writes in place, thus its directory is a copy.
- Under an engine that presents honest host ownership, the cache directory
  takes the mode that lets uid 1000 write it. numba skips an unwritable
  directory in silence, thus a wrong mode loses the whole benefit with no
  error.
- The farm provider resolves the cache location beside the farm location, in
  one resolution.
- Composition stops linking `numba-cache` and `matplotlib_config` into a farm.
  The mount replaces the links.
- `analysis delete` removes the cache in the delete ladder, beside the farm.
  The orphan reaper of `store reclaim` removes a cache whose analysis is gone.
- `store ls` counts the caches in the disk report.

## Capabilities

### Modified Capabilities

- `farm-composition`: the warm-cache links leave the farm. The cache of an
  analysis is a seeded directory with its own lifecycle.
- `package-store-management`: the reaper and the disk report cover
  `farm-caches/`.

## Impact

- `src/modules/libs/composition.ts` — the link pass drops the cache links, and
  the seed of a cache lives beside the farm helpers.
- `src/modules/harness/runtime.ts` — the resolution names the cache beside the
  farm.
- `src/modules/libs/store.ts` — the reaper and the disk report.
- `src/tui/commands.tsx` — the delete ladder.
- The mount mechanics and the seed file of the image belong to the harness
  companion change `per-analysis-cache-mount`.
