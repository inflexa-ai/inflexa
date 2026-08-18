# Tasks — Per-Analysis Warm Caches

## 1. The creation and the seed

- [ ] 1.1 Make `farm-caches/<analysisId>` at sandbox creation, beside the step tree, with the engine-fact mode rule
- [ ] 1.2 Seed the cache: hardlink the numba entries with the structure preserved, and copy the matplotlib directory
- [ ] 1.3 Fall back to a copy of an entry when a hardlink fails
- [ ] 1.4 Do a test: a seeded numba file shares the inode of its catalog source
- [ ] 1.5 Do a test: the sandbox uid can write the cache under the pinned engine, because numba reports nothing on a miss
- [ ] 1.6 Do a test: a write beside the seed leaves each catalog inode unchanged

## 2. The resolution

- [ ] 2.1 Name the cache location beside the farm location in the resolution that the provider gives the harness
- [ ] 2.2 Do a test: a resolution names the farm and the cache of one analysis, and never the cache of another

## 3. The farm links

- [ ] 3.1 Drop the cache links from the link pass of the composer
- [ ] 3.2 Do a test: a composed farm holds packages and markers only

## 4. The lifecycle

- [ ] 4.1 Remove the cache in the delete ladder of `analysis delete`, in the stage that removes the farm
- [ ] 4.2 Add the orphan caches to the reaper of `store reclaim`, beside the orphan farms
- [ ] 4.3 Count the caches in the disk report of `store ls`
- [ ] 4.4 Do a test: the delete removes the farm and the cache, and the catalog is untouched
- [ ] 4.5 Do a test: the reaper removes a cache whose analysis is gone, and it never touches the catalog

## 5. The spec sync

- [ ] 5.1 Make sure that the `per-analysis-farms` deltas hold beside these deltas, and adjust where they disagree
- [ ] 5.2 Run `openspec validate per-analysis-warm-caches --strict` and resolve each finding
