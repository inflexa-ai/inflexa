## 1. The seam resolution

- [x] 1.1 In `src/modules/libs/composition.ts`, move the switch over a `QueryResolution` into one function. `resolvePackageRequest` calls it over the graph index.
- [x] 1.2 In the same file, make `linkPackagesIntoFarm` read the image record of the store. Join `imagePoolIndex` to the graph index, and resolve each query one time.
- [x] 1.3 In the same file, answer `present` with the runtime version for an identity that only the image holds. Link nothing for it.

## 2. The tests

- [x] 2.1 In `src/modules/libs/composition.test.ts`, add the three scenarios: a base R package is present, a standard-library module is present, and a store with no record keeps the answer of the graph.

## 3. Verification

- [x] 3.1 Link the working-copy harness with `bun run harness:local`.
- [x] 3.2 Run `bun run format:file`, `bun run typecheck`, and the tests of `composition.test.ts`.
- [x] 3.3 Run `openspec validate resolve-plan-packages-at-submit --strict`.
