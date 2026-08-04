## 1. Block model types

- [x] 1.1 Add `harness/src/contracts/report-blocks.ts` with the `Block` Zod discriminated union on `kind` (`section`, `text`, `claim`, `metric`, `table`, `chart`, `figure`, `citation`), each with an `id`, a `kind`, and a type-specific content payload
- [x] 1.2 Add the content-grammar refinement so that a `section` holds any kind, and `text` and `claim` are leaf blocks with inline text only
- [x] 1.3 Make the atoms (`table`, `chart`, `figure`, `metric`) hold no block children, and reject a grammar violation
- [x] 1.4 Make the root hold at least one section, and a `section` hold at least one block
- [x] 1.5 Make the binding field non-optional on `claim`, `metric`, `table`, `chart`, `figure`, and `citation`, absent on `text`, and exactly one scalar reference on `metric`
- [x] 1.6 Infer the TypeScript types from the Zod schemas

## 2. Grounding reference types

- [x] 2.1 Add `harness/src/contracts/report-reference.ts` with the `Reference` Zod object (`kind` of `artifact-value`, `artifact-table`, `derivation`, `citation`), the artifact pin (`run`, `path`, `hash`, optional `snapshot`), the optional `assert`, `unit`, and `format`, and the `derivation` transform (`op` of `ratio`, `delta`, or `pctChange`, plus `inputs`)
- [x] 2.2 Add the `locator` union (`column`, `rowFilter`, `row`), make `rowFilter` the default row selector, permit `row` by index, and resolve to exactly one value
- [x] 2.3 Add the `UnresolvedReference` type with the reason set (`artifact-missing`, `hash-mismatch`, `locator-out-of-range`, `ambiguous-match`, `assertion-failed`)
- [x] 2.4 Add the canonical URI serialize and deserialize for a reference, and make the round-trip preserve it
- [x] 2.5 Constrain a `derivation` input to a non-derivation reference, so a derivation cannot nest

## 3. Validator and resolver seam

- [x] 3.1 Add the `ReferenceResolver` seam interface with a `resolve(reference, snapshot)` operation in `harness/src/report-model/reference-resolver.ts`
- [x] 3.2 Add a local fixture resolver that reads a fixture snapshot (a map of `path` and `hash` to rows) for the prototype benchmark
- [x] 3.3 Add the mechanical validator in `harness/src/report-model/validate.ts` that runs schema conformance, binding presence, resolution, and assertion match in order
- [x] 3.4 Add the materialize-first cell lookup and the `derivation` path that resolves each input, runs the `op`, then matches the `assert`
- [x] 3.5 Add the metric-slot numeral rule as a hard failure, and the free-numeral warning as an advisory result

## 4. Tests

- [x] 4.1 Add a fixture report that holds one of each block kind, each grounded, and a test that it validates
- [x] 4.2 Add a test that a `claim` with a non-resolving coordinate fails with `artifact-missing` or `locator-out-of-range`
- [x] 4.3 Add a test that a `claim` with a correct coordinate but a wrong `assert.value` fails with `assertion-failed`
- [x] 4.4 Add a test that a grammar violation (a `chart` inside a `metric`) fails, and that an empty report and an empty section fail
- [x] 4.5 Add a test that a `rowFilter` with many matches fails with `ambiguous-match`
- [x] 4.6 Add a test that a `derivation` over two grounded cells validates, one with a non-resolving input fails, and a nested derivation is rejected
- [x] 4.7 Add a test that a reference round-trips through serialize and deserialize

## 5. Verify

- [x] 5.1 Run `tsc -p tsconfig.json` and make sure it passes
- [x] 5.2 Run the new test files with `bun test` and make sure they pass
- [x] 5.3 Run `bun run format:file` on the changed `src/` files
- [x] 5.4 Run `openspec validate add-report-block-grounding-model --type change --strict` and make sure it passes

## 6. Verification follow-ups

- [x] 6.1 Add the `artifact-file` reference kind for a whole-file pin, and bind a `figure` to it instead of `artifact-table`
- [x] 6.2 Make the `rows` of a snapshot artifact optional, because a pinned image has a hash and no rows
- [x] 6.3 Resolve an `artifact-file` in the fixture resolver, and add the file variant to `ResolvedValue`
- [x] 6.4 Add the block-level rejection tests for a missing `id`, an empty `id`, a missing `kind`, and an unknown `kind`
- [x] 6.5 Add the block-level rejection test for a `metric` that carries a second binding
- [x] 6.6 Add the whole-file pin tests for a figure that resolves, a missing path, a hash mismatch, and a derivation over a file input
- [x] 6.7 Add the cross-session test that resolves a serialized and parsed reference to the same value
- [x] 6.8 Update the `report-grounding` delta for the `artifact-file` kind, then run the typecheck, the tests, and the strict validation again
