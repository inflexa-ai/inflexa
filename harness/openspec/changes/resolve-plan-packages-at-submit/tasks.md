## 1. The image record

- [x] 1.1 In `images/sandbox-base/scripts/image-record.py`, add `r_base` from `installed.packages(priority = "base")` of the R runtime, and `python_stdlib` from `sys.stdlib_module_names`. Fail the assembly on an empty set.
- [x] 1.2 In `src/sandbox/image-packages.ts`, add `r_base` and `python_stdlib` as optional string arrays of `ImagePackagesSchema`.
- [x] 1.3 In `src/sandbox/image-packages.test.ts`, add two scenarios: a record with the two fields parses, and a record without them parses.

## 2. The pool indexes

- [x] 2.1 In `src/sandbox/package-identity.ts`, add `joinPoolIndexes(first, second)`.
- [x] 2.2 In `src/sandbox/image-packages.ts`, add `imagePoolIndex(record)`.
- [x] 2.3 In `src/sandbox/package-identity.test.ts`, add the three join scenarios.
- [x] 2.4 In `src/sandbox/image-packages.test.ts`, add the three image-index scenarios.
- [x] 2.5 In `src/index.ts`, export `joinPoolIndexes`, `imagePoolIndex`, `readImagePackagesFile`, and the `ImagePackages` type for the embedder.

## 3. The validation

- [x] 3.1 In `src/schemas/validate-plan.ts`, add `pool?: PoolIndex` to `ValidatePlanOptions`. Resolve each parsed entry with `resolveQuery` when the index is given.
- [x] 3.2 In the same file, give an issue for `ambiguous` with the two prefixed forms. Give an issue for `unknown` with the suggestion, when there is one.
- [x] 3.3 In `src/schemas/validate-plan.test.ts`, add the scenarios: a bare both-track name is refused, `sklearn` is refused, `seurat` is refused with `Seurat`, `r:stats` and `json` pass, and no index resolves nothing.

## 4. The census index of the planner

- [x] 4.1 In `src/tools/sandbox/list-available-packages.ts`, give the valid record on the `sections` arm of `InventoryRead`. Add `inventoryPoolIndex(sections, record)`, which joins the tracked rows and `imagePoolIndex`.
- [x] 4.2 In the same file, add a function that answers a packages query from one `InventoryRead`. The tool `execute` uses it.
- [x] 4.3 In `src/tools/research/generate-plan.ts`, read the inventory one time. Render the seed block from that read, and build the index from the same read when `readPoolInventory` is bound and the read gives sections.
- [x] 4.4 In the same file, pass the index through `buildInnerTools` to `fullyValidate`, and from there to `validatePlan`.
- [x] 4.5 In `src/tools/sandbox/catalog-tools.test.ts`, add the scenarios of `inventoryPoolIndex`: a tracked row resolves, a base name of the record resolves, and an untracked row does not resolve.

## 5. Verification

- [x] 5.1 Run `bun run format:file` on each changed source file.
- [x] 5.2 Run `tsc -p tsconfig.json`. Run `bun test` on the changed test files.
- [x] 5.3 Run `openspec validate resolve-plan-packages-at-submit --strict`.
