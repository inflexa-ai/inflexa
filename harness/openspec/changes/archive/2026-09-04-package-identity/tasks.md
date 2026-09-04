## 1. The module

- [x] 1.1 Make `src/sandbox/package-identity.ts` with `Track`, `PackageQuery`, the branded `PackageIdentity`, `pythonIdentity`, `rIdentity`, `identityOf`, `identityKey`, and `identityAddress`. The fold exists once, in this file.
- [x] 1.2 In the same file, add `parseQuery` with the four typed errors, `formatQuery`, the `PoolIndex` type, and `resolveQuery` with the six-step ladder of the spec.
- [x] 1.3 Export the module from `src/index.ts`.
- [x] 1.4 Make `src/sandbox/__fixtures__/package-identity.json`: the parse cases, the key and address cases, and the round-trip cases of the spec scenarios.
- [x] 1.5 Make `src/sandbox/package-identity.test.ts`: read the fixture, pin the eight ladder scenarios, and pin the literal-is-not-an-identity case with `@ts-expect-error`.

## 2. The seam

- [x] 2.1 In `src/sandbox/types.ts`, replace `PackageRequest` with `PackageQuery`, make each outcome carry `spelling`, make `ExtendAnalysisFarm` take `PackageQuery[]`, and delete `shelfKey`.
- [x] 2.2 Delete `src/sandbox/types.test.ts`, because its one test pinned `shelfKey`.

## 3. The plan grammar

- [x] 3.1 In `src/schemas/validate-plan.ts`, parse each entry with `parseQuery`, and map each error to an issue that names the step and the entry.
- [x] 3.2 In the same file, delete `PACKAGE_PREFIX` and the two entry regexes.
- [x] 3.3 In `src/schemas/workflow-state.ts`, describe the `packages` field as queries in the one grammar.
- [x] 3.4 In `src/tools/execute-analysis.ts`, delete `parseRequirement`. Build the union with `parseQuery`, dedupe equal queries by `formatQuery`, absorb nothing, and pass the queries to the seam.
- [x] 3.5 In the same file, make the collision refusal write the two prefixed forms with `formatQuery`.
- [x] 3.6 In `src/schemas/validate-plan.test.ts`, add the leading-space scenario. In `src/tools/execute-analysis.test.ts`, replace the absorption tests with the equal-queries scenario and the bare-beside-qualified scenario.
- [x] 3.7 In `src/prompts/planner.ts`, keep the grammar sentences, and name no `ecosystem` field.

## 4. The link tool and its prompt layer

- [x] 4.1 In `src/tools/sandbox/link-packages.ts`, take `packages` as strings, parse each with `parseQuery`, and delete the `ecosystem` field.
- [x] 4.2 In the same file, refuse the call on a parse error, with the entry and the issue in the refusal.
- [x] 4.3 In the same file, make the description name the prefixed retry `python:<name>` or `r:<name>`.
- [x] 4.4 In `src/prompts/sandbox-standards.ts`, make `sandboxPackageLinkPrompt` teach the prefixed retry, and name no `ecosystem` field.
- [x] 4.5 Make `src/tools/sandbox/link-packages.test.ts`: a prefixed entry reaches the seam as a qualified query, and an entry that does not parse refuses the call.
- [x] 4.6 In `src/agents/sandbox/shared.test.ts`, assert the prefixed retry in the composed prompt.

## 5. The census

- [x] 5.1 In `src/config/environment-stores.ts`, add `track?: Track` to `PoolInventorySection`, and add `suggestion?: string` to the absent shape of `CheckedPackage` where that type lives.
- [x] 5.2 In `src/tools/sandbox/list-available-packages.ts`, add one function that maps a lock subtree to a track, and set `track` on each package section.
- [x] 5.3 In the same file, read `section.track` in the `language` filter, and delete the two title regexes.
- [x] 5.4 In the same file, make the `names` path build a `PoolIndex` from the package sections and call `resolveQuery`. A resolved query answers one entry, an ambiguous query one entry per track, an unknown query an absent entry with the suggestion.
- [x] 5.5 In the same file, match a system tool or a node package by its rendered name exactly, and mark a both-track name from the identities.
- [x] 5.6 In `src/tools/sandbox/catalog-tools.test.ts`, rewrite the `names` tests: `seurat` and `DESEQ2` answer absent with the suggestion, `scikit_learn` answers `scikit-learn`, `decoupler` answers one entry, `igraph` answers two, and a `language: "r"` filter reads the track.

## 6. The provisioner

- [x] 6.1 Make `images/sandbox-provisioner/package_identity.py`: `PackageIdentity`, `PackageQuery`, `python_identity`, `r_identity`, `identity_of`, `key`, `address`, `parse_query`, and `format_query`. It imports neither caller.
- [x] 6.2 Make `images/sandbox-provisioner/test_package_identity.py`: read the harness fixture by a path relative to the repository root, skip with a named reason when it is absent, and assert each case.
- [x] 6.3 In `emit_deps.py`, delete `canon`, mint each node name with `python_identity` or `r_identity`, drop `r_dir`, resolve each edge through `identity_of(track, name).name`, and keep `GRAPH_VERSION` at 2.
- [x] 6.4 In the same file, delete `folded_r_names` and its gate block. Keep the dangling-edge stop and the both-track log line.
- [x] 6.5 In `provision.py`, delete `canon`, `ECOSYSTEMS`, `SPEC_PREFIX`, and `parse_spec`. Read each spec with `parse_query`, address each store directory with `identity.address`, and report both-hit candidates as identity keys.
- [x] 6.6 In `images/package-store/load-check.py`, read `name` only for an R node.
- [x] 6.7 In `test_provision.py`, drop `r_dir` from each fixture, delete the folded-R gate tests, and add the `GO.db` address scenario and the both-hit identity scenario.

## 7. Verification

- [x] 7.1 Run `bun run format:file` on each changed file under `src/`.
- [x] 7.2 Run `npx tsc -p tsconfig.json`, `bun run lint`, and `bun test` on each touched test file in `harness/`. Then run `bun run build`, so the cli link sees the export.
- [x] 7.3 Run `python3 -m unittest` in `images/sandbox-provisioner/`.
