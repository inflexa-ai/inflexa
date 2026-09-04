## 1. The import

- [x] 1.1 Link the working-copy harness with `bun run harness:local`, and make sure that `package-identity` resolves from `@inflexa-ai/harness`.
- [x] 1.2 In `src/modules/libs/composition.ts`, import `PackageQuery`, `identityOf`, `identityKey`, `identityAddress`, `resolveQuery`, and `formatQuery`. Delete `canonicalDistributionName`.

## 2. The resolution

- [x] 2.1 In `composition.ts`, build a `PoolIndex` over `DepsGraph`: `has` reads the shelf of the track under the name, and `rIdentitiesFoldingTo` scans the R shelf by address.
- [x] 2.2 In the same file, rewrite `resolvePackageRequest` as a call to `resolveQuery` followed by the version pick. Delete the local ladder.
- [x] 2.3 In the same file, make `unknown_distribution` carry `suggestion` as an identity key, and make `ambiguous_ecosystem` carry the two identity keys.
- [x] 2.4 In the same file, delete the `name` field of each refusal shape.
- [x] 2.5 In the same file, drop `rDir` from `DepsNode` and from the reader, and let an extra `r_dir` field pass unread. Keep `GRAPH_VERSION` at 2.
- [x] 2.6 In the same file, make the seam realization take `PackageQuery[]`, and echo `spelling` in each outcome.
- [x] 2.7 In the same file, put the two identity keys in the detail of a two-track collision.

## 3. The ledger

- [x] 3.1 In `src/db/primary_migrations.ts`, add migration 10: rebuild `pending_store_adds` and `package_store_flights` with `spelling` in place of `name` and `raw_name`, filled from `raw_name` and else from `name`.
- [x] 3.2 In `src/types/store.ts`, `src/db/primary_query.ts`, and `src/db/primary_mutation.ts`, replace `name` and `rawName` with `spelling`, and make the dedupe compare the spelling, the specifier, and the track.
- [x] 3.3 In `src/modules/libs/store_flight.ts`, make the flight id `<track or any>::<spelling>::<specifier>`, make the spec mint take a `PackageQuery`, and make `provisionerSpec` call `formatQuery`.
- [x] 3.4 In the same file, make `classifyPoolMiss` take a query, and match a row by identity when both carry a track, and by spelling otherwise.
- [x] 3.5 In the same file, resolve a bare edge of the acquisition commit through `identityOf(node.track, edge).name`.

## 4. The commands and the replay path

- [x] 4.1 In `src/modules/libs/store.ts`, parse the argument of `store add` and of `store link` with `parseQuery`, and merge `--version` and `--lang` into the query.
- [x] 4.2 In the same file, refuse a prefix in the argument with the `--lang` remedy.
- [x] 4.3 In the same file, make `describeRequestRefusal` take the query, render the spelling of the suggestion, and read no `name` field.
- [x] 4.4 In `src/modules/harness/dev/run.ts`, parse each plan entry with `parseQuery`.
- [x] 4.5 In `src/modules/harness/runtime.ts`, pass the query to `classifyPoolMiss`, and keep the suggestion ahead of the store-add ask.
- [x] 4.6 In `src/tui/components/failed_flight_dialog.tsx` and `src/tui/layout/design_gallery.tsx`, read the spelling and the new flight id form.

## 5. The inventory

- [x] 5.1 In `src/modules/libs/packages.ts`, set `track` on each section, and keep the titles as display.
- [x] 5.2 In `src/modules/libs/test-fixtures/farm-parity/deps.json`, drop `r_dir` from each R node.

## 6. The tests

- [x] 6.1 In `src/modules/libs/composition.test.ts`, replace the ladder tests with the five scenarios of the delta, the version-pick scenario, and the `r_dir` read scenario.
- [x] 6.2 In `src/modules/libs/store_flight.test.ts`, pin the flight id form, the identity match of `classifyPoolMiss`, and the edge resolution through `identityOf`.
- [x] 6.3 In `src/modules/libs/store.test.ts`, pin the pinned-argument scenario, the prefix refusal, and the suggestion render.
- [x] 6.4 In `src/db/primary_migrations.test.ts`, pin migration 10 over a row with a `raw_name` and over a row without one.
- [x] 6.5 In `src/modules/libs/packages.test.ts`, pin the track of a section.
- [x] 6.6 In `src/modules/harness/runtime.test.ts`, pin that a Python flight does not answer an R miss.

## 7. Verification

- [x] 7.1 Run `bun run typecheck` and `bun run lint`.
- [x] 7.2 Run `bun test src/modules/libs/ src/modules/harness/ src/db/` in chunks, because the full suite exhausts memory in one run.
- [x] 7.3 Run `bun run format:file` on each changed file under `src/`.
- [x] 7.4 Make sure that `grep -rn "toLowerCase()" src/modules/libs` names no package-name site.
