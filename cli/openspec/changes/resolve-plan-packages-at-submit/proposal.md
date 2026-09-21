## Why

The harness change `resolve-plan-packages-at-submit` resolves each plan package
at `submit_plan` with `resolvePackage`, and it counts a base R package and a
Python standard-library module as present. The link pass of the cli must give
the same answer. Today the link pass refuses `r:stats` and `json`, because the
graph does not hold them (issue #512).

## What Changes

- `linkPackagesIntoFarm` reads the image record at the root of the store one
  time for the batch. It resolves each query with `resolvePackage` of the
  harness, over the graph index and the image base.
- An `image` answer is `present`, with the runtime version of the record, and
  the seam links nothing. A wrong pin of an image package refuses with
  `unknown_version`.
- A damaged record answers `unavailable` for each query. An absent record gives
  the empty image base.
- An ambiguous spelling reports a collision whose claims come from the pool or
  from the image.
- `store link` and `store add` keep their resolution over the graph alone.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `farm-composition`: the requirement "Extension walks the graph and refuses
  ambiguity" states the seam route over the graph and the image base.

## Impact

- `cli/src/modules/libs/composition.ts`: the seam resolution and its outcome.
- `cli/src/modules/libs/composition.test.ts`: the new scenarios.
