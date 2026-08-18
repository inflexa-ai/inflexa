# Design — Per-Analysis Warm Caches

## Context

The harness change `per-analysis-cache-mount` declares the contract. The
resolution names a cache beside the farm. The sandbox mounts it read-write at
`/mnt/libs/cache`, and the seed file exports the env at the mounted paths. Its
design records the measured facts. This change decides the embedder side.

## Goals / Non-Goals

**Goals:**

- A cache exists and is seeded before the first sandbox of an analysis reads
  it, at almost no disk cost.
- The cache is writable by the sandbox user under each engine that the CLI
  pins.
- The cache dies with its analysis, through the paths that already remove the
  farm.

**Non-Goals:**

- The mount mechanics and the seed file. The harness change owns them.
- A cache that outlives its analysis, or a harvest back into the catalog. The
  catalog stays the one trusted seed source, and only CI writes it.

## Decisions

### D1 — The cache lives under the store root, beside the farms

`farm-caches/<analysisId>` sits beside `farms/` at the store root. The
read-only ceiling of the store comes from the BIND, not from the directory,
and the nested farm bind already proves the pattern. One location rule then
serves the reaper, the disk report, and the delete ladder. The Kubernetes
subPath of the harness change points at the same relative path.

Alternative — a directory outside the store root: rejected. It would need its
own lifecycle sweep, and the store report would not see it.

### D2 — Creation happens at sandbox creation, beside the step tree

`precreateStepTree` already runs at sandbox creation, and it holds the engine
fact `engineBindOwnership` that decides the permissions. The cache directory
is created and seeded there, with the same rule: under an engine that presents
honest host ownership, the directory takes the mode that uid 1000 can write.

numba skips an unwritable cache directory in silence, for a read as much as a
write. Thus a wrong mode does not fail — it quietly loses every load. The
tests of this change must prove the mode under the pinned engine, because no
error will.

Alternative — creation at `analysis new`, beside the farm: rejected. That code
does not hold the engine fact, and a mode chosen without it repeats the silent
loss that the step tree already solved.

### D3 — The seed rule: hardlink numba, copy matplotlib

The numba entries of the catalog hardlink into the cache, structure preserved.
numba writes only through `os.replace`. Thus a run replaces its own directory
entry, and the catalog inode survives. The measurement showed the catalog
inode intact after a run wrote beside it. A hardlink costs no bytes, thus ten analyses cost
one catalog.

matplotlib writes its font cache in place. Its directory is a COPY, because an
in-place write must land in a file that the analysis owns. The directory is
small, thus the copy costs almost nothing.

A hardlink wants one filesystem. The cache sits under the same store root as
the catalog, thus the seed and the source share one volume by construction.
When a hardlink still fails, the seed falls back to a copy of that entry,
because a copied seed is correct and only costs bytes.

### D4 — Death follows the analysis, through the existing ladders

`analysis delete` removes the cache in the delete ladder, in the same stage
that removes the farm. The lease check of the farm already guards the stage. A live sandbox reads
the cache exactly as it reads the farm.
The orphan reaper of `store reclaim` removes a cache whose analysis id the
database no longer holds, beside the farm reaper. The catalog seed directories
belong to the catalog farm, and the reaper never touches them.

### D5 — Composition stops writing the cache links

The link pass of the composer drops `numba-cache` and `matplotlib_config`.
The farm carries packages and markers only. An existing farm that still holds
the two links is harmless: the links point into the read-only store, the seed
file no longer reads them, and the next farm never gets them.

## Risks / Trade-offs

- [A silent unwritable cache] The engine mode decides everything, and numba
  reports nothing. → The tests prove a write from the sandbox uid under the
  pinned engine, and the effectiveness check of the harness change proves the
  loads.
- [Concurrent steps drop entries] Accepted in the harness design, with its
  measured bounds and its named residual risk.
- [Disk growth across many analyses] Each cache holds hardlinks plus what its
  runs compiled. The reaper and the delete ladder bound the population.

## Migration Plan

Nothing shipped carries the old arrangement. The two changes land together,
and a store needs no rebuild: the catalog directories stay where they are.

## Open Questions

(none — the decisions were settled in conversation with the user)
