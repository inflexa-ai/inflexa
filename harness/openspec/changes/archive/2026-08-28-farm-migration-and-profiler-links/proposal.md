# Proposal: farm-migration-and-profiler-links

## Why

The data profiler is a sandbox agent, and its sandbox resolves the per-analysis
farm. Under the farm model a new analysis profiles first, thus the profiler
meets the farm at its emptiest. The image bakes no packages, and the profiler
deps bag omits the farm-extension seam. Thus the profiler cannot read an h5ad,
a mzML, or an xlsx file, and it cannot link the reader it misses.

## What Changes

- The data-profile workflow forwards the farm-extension seam into the profiler
  agent deps. The `link_packages` layer then rides, per the existing
  harness-sandbox-agents requirement, and the profiler links a reader by need.
- The prompt layer of the substrate rides automatically when the seam binds.
  No prompt edit exists — the guidance names the mechanism, never a package
  list.
- No new seam and no config key. The embedder that binds `extendAnalysisFarm`
  for the step agents feeds the profiler with the same realization.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `data-profile-init`: the profile run gives the profiler the farm-extension
  seam of the embedder, thus a by-need link works before the first plan
  exists.

## Impact

- `src/tasks/data-profile.ts`: the deps bag carries `extendAnalysisFarm`.
- `src/agents/sandbox/shared.ts`: unchanged — the gate on the bound seam
  already attaches the tool and the prompt layer.
- The embedder passes its realization at the composition root. Without it the
  profiler keeps the current shape, thus the managed service adopts by config.
