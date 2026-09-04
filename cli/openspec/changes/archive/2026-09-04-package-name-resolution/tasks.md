## 1. The shelf key, imported from the harness

- [x] 1.1 Link the working-copy harness with `bun run harness:local`, so that `shelfKey` resolves from `@inflexa-ai/harness`.
- [x] 1.2 In `src/modules/libs/composition.ts`, import `shelfKey`. Keep `canonicalDistributionName` for the flight key and the Python shelf.

## 2. The lookup

- [x] 2.1 In `composition.ts`, rewrite `resolvePackageRequest` as the ladder of the design: a qualified request reads one shelf, then the five unqualified steps in order.
- [x] 2.2 In the same file, add the optional `suggestion` to `unknown_distribution`. Set it when exactly one R key folds to the fold of the request.
- [x] 2.3 In the same file, make the seam `collision` outcome of a two-track hit carry a `detail` that names the track of each store directory.
- [x] 2.4 In the same file, make the seam `absent` outcome carry the suggestion in its `detail`, so that the launch refusal renders it.
- [x] 2.5 In the same file, set `GRAPH_VERSION` to 2. Make the `graph_unusable` render name `inflexa store download --update` for a lower version on disk, and a host upgrade for a higher one.
- [x] 2.6 In `src/modules/libs/store_flight.ts`, resolve a bare edge of the acquisition commit with `shelfKey(node.track, edge)`.
- [x] 2.7 In `src/modules/libs/store.ts`, make `describeRequestRefusal` render the suggestion of an `unknown_distribution` before the store-add ask.
- [x] 2.8 In `src/modules/harness/runtime.ts`, put the suggestion of the resolution before the store-add ask of the launch remedy.
- [x] 2.9 In `src/modules/libs/store_flight.ts`, refuse the commit of an acquisition when the graph on disk carries another version.

## 3. The tests

- [x] 3.1 In `src/modules/libs/composition.test.ts`, move each `by_name.r` fixture to the exact spelling, and each graph fixture to version 2.
- [x] 3.2 In the same file, add the ladder scenarios: `decoupleR` gives R, `decoupler` gives Python, and `igraph` stops as ambiguous with the tracks in the detail.
- [x] 3.3 In the same file, add the two fold scenarios: `seurat` is unknown with the suggestion `Seurat`, and `PyYAML` folds to `pyyaml`.
- [x] 3.4 In the same file, add the two version scenarios: a version-1 graph refuses with the update remedy, and a version-3 graph refuses with the upgrade remedy.
- [x] 3.5 In `src/modules/libs/store.test.ts`, assert that the `unknown_distribution` refusal renders the suggestion before the store-add ask.
- [x] 3.6 In `src/modules/libs/store_flight.test.ts`, assert that an R edge with an uppercase name resolves against the exact key of the R shelf.
- [x] 3.7 In `src/modules/libs/packages.test.ts`, assert that an R node renders its exact spelling in the R section.
- [x] 3.8 In `src/modules/harness/runtime.test.ts`, assert that the launch remedy names the suggestion before the store-add ask.
- [x] 3.9 In `src/modules/libs/store_flight.test.ts`, assert that a graph of another version refuses the commit with the remedy of its direction.

## 4. Verification

- [x] 4.1 Run the typecheck of the cli.
- [x] 4.2 Run `bun test` over `src/modules/libs/` in chunks, because the full cli suite exhausts memory in one run.
- [x] 4.3 Run the formatter of the cli on each changed file under `src/`.
