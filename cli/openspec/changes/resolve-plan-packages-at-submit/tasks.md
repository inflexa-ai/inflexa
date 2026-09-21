## 1. The seam resolution

- [x] 1.1 In `src/modules/libs/composition.ts`, make `linkPackagesIntoFarm` read the image record of the store one time for the batch.
- [x] 1.2 In the same file, answer `unavailable` for each query when the record does not parse. Give the empty image base when the record is absent.
- [x] 1.3 In the same file, resolve each query with `resolvePackage` of the harness, over the graph index and the image base.
- [x] 1.4 In the same file, answer `present` with the runtime version for an `image` answer, and link nothing for it.
- [x] 1.5 In the same file, refuse an `image_version` answer with `unknown_version`.
- [x] 1.6 In the same file, build the claims of an ambiguous spelling with a total `claimOf`.
- [x] 1.7 In the same file, keep the body of `resolvePackageRequest` for `store link` and `store add`.

## 2. The tests

- [x] 2.1 In `src/modules/libs/composition.test.ts`, add the scenarios: a base R package is present, a standard-library module is present, and a store with no record keeps the answer of the graph.
- [x] 2.2 In the same file, add the scenarios: a wrong pin refuses, a pool spelling keeps its answer, a collision of two image claims, and a damaged record answers unavailable.

## 3. Verification

- [x] 3.1 Link the working-copy harness with `bun run harness:local`.
- [x] 3.2 Run `bun run format:file`, `bun run typecheck`, and the tests of `composition.test.ts`.
- [x] 3.3 Run `openspec validate resolve-plan-packages-at-submit --strict`.
