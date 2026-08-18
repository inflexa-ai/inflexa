# Design — Per-Analysis Cache Mount

## Context

A sandbox reads its prepared caches through a copy. `seed_caches` moves the
cache of the farm to `/tmp`, because numba selects a cache directory by a write
probe and skips a read-only one. The copy dies with the container, thus each
kernel that a run compiles is paid again by the next run.

The measured facts that constrain this design:

1. A numba entry is one function at one type signature. An import compiles
   nothing that the package does not declare eagerly.
2. numba writes only through `os.replace`. A write swaps a directory entry, and
   it never writes through an inode.
3. matplotlib writes its font cache in place, through `open(filename, "w")`.
4. numba loads its index again on each save. Two racing saves can drop an
   entry, and the measured loss varied from none to half. A dropped entry
   compiles again, and a torn index cannot appear, because each write lands
   through an atomic replace.
5. A host directory that uid 1000 cannot write is skipped by numba in silence,
   with no error. The engine fact `engineBindOwnership` and the step-tree
   `chmod` are the existing precedent (`create-sandbox.ts:182-184`).
6. A read-write bind nested under a read-only parent works, and the farm bind
   proves it: `farms/<id>` lives under the store root, and it mounts on its
   own. Kubernetes gives the same shape with a second mount of the store PVC,
   `subPath` under it, `readOnly: false`.

## Goals / Non-Goals

**Goals:**

- A kernel compiles one time for each analysis, and each later step of that
  analysis loads it.
- The catalog preparation seeds each cache, thus the first step of an analysis
  starts as warm as the catalog.
- One contract serves the Docker backend and the Kubernetes backend.

**Non-Goals:**

- A cache that two analyses share at run time. A `.nbc` file is machine code,
  and a shared writable home would be a cross-analysis execution channel.
- A lock over concurrent writers. The loss is bounded, a dropped entry only
  compiles again, and a lock would serialize real work to save a recompile.
- The creation, the seed, and the removal of the cache. The embedder owns
  them, and the companion CLI change specifies them.

## Decisions

### D1 — The cache location rides beside the farm resolution

The farm provider answers "where is the farm of this analysis". The cache asks
the same question with the same shape, thus the answer rides in the same
resolution: the provider names the farm location and the cache location
together. On Docker both are host paths. On Kubernetes both are subPaths under
the store PVC. The harness derives neither, because the layout of the store
belongs to the embedder.

A resolution can name a farm and no cache. The sandbox then mounts no cache,
`seed_caches` finds nothing, and the run compiles cold into the container.
That is the state of an embedder that has not seeded a cache, and it is a
degradation and not an error.

Alternative — a second provider seam: rejected. The two answers resolve from
one analysis id at one moment, and a second seam could disagree with the first.

### D2 — The container path is a third nested mount

The cache mounts read-write at `/mnt/libs/cache`, nested inside the read-only
store mount, beside the farm at `/mnt/libs/current`. The store and the farm
stay read-only, thus a step still cannot rewrite a package link.

On the host the cache lives at `farm-caches/<analysisId>` under the store
root, as a sibling of `farms/`. The nested-bind precedent makes the placement
safe on Docker, and the subPath mount makes it the same on Kubernetes. One
location rule serves the reaper, the disk report, and the delete ladder.

### D3 — The seed copies nothing

`seed_caches` exports `NUMBA_CACHE_DIR=/mnt/libs/cache/numba-cache` and
`MPLCONFIGDIR=/mnt/libs/cache/matplotlib_config` when the mount is present,
and it copies no file. The write probe of numba passes, because the mount is
read-write. An absent mount exports nothing, and the run compiles into the
container as before.

The seed of the cache CONTENT is host work, before the mount: hardlink the
numba entries of the catalog, and copy the matplotlib directory. Fact 2 makes
the hardlink safe for numba — a run replaces its own directory entry, and the
catalog inode survives, measured. Fact 3 forbids the hardlink for matplotlib —
an in-place write through a shared inode would reach the catalog copy. The
sandbox cannot open the catalog-owned file for write. Thus the failure is a
lost update and not a corruption, and a copy removes even that.

### D4 — The loss under concurrent writers is accepted, and named

Fact 4 bounds the failure: a racing save can drop an index entry, and the
dropped entry compiles again on its next call. Steps of one analysis mostly run
in sequence through the DAG, thus the racing case is the exception.

One residual risk is narrower and real: two racing saves can pick one data
file name, and one interleaving can leave an index key that names the data of
another key. The measurements never produced it, and no test proves it
impossible. A load of a mismatched entry is the worst case. The checks of the
companion change must watch for it before this design widens.

### D5 — The farm loses its cache links

Today a composed farm links `numba-cache` and `matplotlib_config` into the
catalog farm, and the seed copies through those links. Under the mount the
links select nothing, thus composition stops writing them. The catalog farm
keeps its prepared directories: they are the seed source, and the build check
still proves them effective.

### D6 — The effectiveness check reads the mounted shape

The lesson of the entrypoint check holds here too: a check must exercise the
shape that production uses. The check of the build mounts a seeded cache
read-write at the container path. It sources the seed file, and it proves that
each recorded entry loads through the mount. A check against the copy-to-`/tmp`
shape would prove a mechanism that no sandbox runs.

## Risks / Trade-offs

- [A per-machine cache] A numba key holds the CPU on x86, and the store is a
  host directory. A cache never moves between machines, thus the key never
  crosses one. No mitigation is necessary.
- [Unbounded growth] Each new signature adds an entry, and nothing removes one
  inside a run. The cache dies with its analysis, and the companion change
  puts its removal in the delete ladder and the reaper.
- [A seeded entry that never loads] The two uncacheable kernels of the sparse
  route write on each run. They ride the seed and load never, which costs
  bytes and nothing else.

## Migration Plan

Nothing shipped carries the old arrangement, thus nothing migrates. The seed
file and the mount land together, and the companion CLI change lands the
creation and the seeding.

## Open Questions

- The residual index-data race of D4: watch it, or serialize the writers of
  one analysis later if a mismatched load is ever observed.
