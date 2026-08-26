# Design: farm-migration-and-profiler-links (harness side)

## Decision: the seam rides the existing gate

The substrate already attaches `link_packages` and its prompt layer when the
deps carry `extendAnalysisFarm` (`agents/sandbox/shared.ts`). Thus the whole
harness change is one field on the profile deps bag, threaded into the
profiler agent deps in `tasks/data-profile.ts`. No new seam, no new tool, and
no prompt fork.

Rejected: a fixed "profiling seed" of packages linked at farm creation. The
profiler needs are data-driven — anndata for h5ad, pyteomics for mzML — and a
seed list is a roll-call that goes stale. The by-need link is the mechanism
the step agents already prove.

Rejected: the catalog farm mounted read-only for the profiler. It changes the
farm resolution per agent kind, and the linked readers would then not seed
the analysis farm that the later steps use.

## Boundary

The embedder decides the realization. The cli passes the same
`linkPackagesIntoFarm` it binds for the step agents. A managed host adopts by
config, and an unbound seam keeps the current shape.
