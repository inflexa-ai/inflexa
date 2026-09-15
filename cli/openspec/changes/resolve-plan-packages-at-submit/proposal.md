## Why

The harness change `resolve-plan-packages-at-submit` resolves each plan package
at `submit_plan`, and it counts a base R package and a Python standard-library
module as present. The link pass of the cli must give the same answer. Today
the link pass refuses `r:stats` and `json`, because the graph does not hold
them (issue #512).

## What Changes

- `linkPackagesIntoFarm` reads the image record at the root of the store. It
  joins `imagePoolIndex` of the harness to the pool index of the graph, and the
  ladder runs one time over the joined index.
- When the ladder resolves an identity that the graph does not hold, the image
  holds it. The seam then answers `present`, with the runtime version of the
  record, and it links nothing.
- `store link` and `store add` keep their resolution over the graph alone.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `farm-composition`: the seam route resolves a query over the graph and the
  image record, and it answers `present` for a package that only the image
  holds.

## Impact

- `cli/src/modules/libs/composition.ts`: the seam resolution and its outcome.
- `cli/src/modules/libs/composition.test.ts`: the new scenarios.
