# Per-Analysis Farms

## Why

Every sandbox mounts the one farm that the store-level `current` pointer names,
so all analyses share one library set. The product moves to parallel analyses.
Each analysis must select its own package closure, at its own versions, at the
same time as the others.

## What Changes

- **BREAKING** — `inflexa store use` goes away. No active farm exists at the
  store level, thus nothing switches it. The harness companion change
  `per-analysis-farm-mount` removes the pointer from the mount contract.
- The CLI composes a farm for each analysis, on the host, with no container.
  Composition walks the resolved dependency graph `deps.json` and links the
  closure from the pool. It hoists the entry points, and it links the warm
  caches from the catalog farm. A per-farm mutex serializes two compositions of
  one farm.
- Composition is lazy. The first sandbox of an analysis makes the farm. A
  chat-only analysis makes none. An import failure extends the farm on demand:
  the agent requests the package, composition links it, the same sandbox
  retries.
- The CLI wires the harness farm provider: analysis id in, `farms/<analysisId>`
  under the store root out. When composition failed, the provider gives no farm,
  and the sandbox gate names that state.
- `store add` becomes pure acquisition. It resolves and downloads into the pool,
  appends to the graph, and does no farm work. Concurrent adds become flights:
  one flight per normalized spec, analyses subscribe to it, a cancel removes one
  subscription, and the flight stops at zero subscribers. Different specs run in
  parallel under a small concurrency cap. The flight state lives in one DB row,
  in the shape of the detached download lifecycle.
- The download merge stops writing `current`. The catalog farm arrives as the
  template and the warm-cache donor, not as the active farm. `deps.json` arrives
  and merges as a store record.
- `analysis delete` removes the farm of the analysis. A removal refuses while a
  lease records a live sandbox of that farm. A reaper keyed on the analyses
  table removes a farm whose analysis is gone.
- The package inventory that the CLI supplies for planning reads the pool, not a
  farm, because composition can link any pool package on demand.
- Migration: the first store command after upgrade removes a stale `current`
  symlink from the store root.

## Capabilities

### New Capabilities

- `farm-composition`: the host-side assembly of a per-analysis farm from the
  pool. It covers the graph walk, the link shapes, the warm-cache links, the
  lazy lifecycle, the extension on demand, and the per-farm mutex.

### Modified Capabilities

- `package-store-management`: `store use` is removed. `store add` becomes
  acquisition with single-flight dedup and parallel flights. Reclaim excludes
  live flights and reaps orphan farms.
- `lib-store-download`: the merge no longer writes `current`. The catalog farm
  merges as the template. `deps.json` merges as a store record.
- `lib-store-provisioning`: the CLI wires the farm provider into the harness,
  and the planning inventory reads the pool.

## Impact

- `src/modules/libs/store.ts` — `store use` removal, flight orchestration,
  reclaim.
- `src/modules/libs/` — new composition module, the graph reader, the farm
  reaper.
- `src/modules/libs/store_download.ts` — the merge order, the template farm,
  `deps.json`.
- `src/modules/harness/runtime.ts` — the provider wiring, the pool inventory.
- `src/cli/index.ts` — the command surface and the agent policies.
- The open change `mandatory-store-and-farm-switch` names `store use` and the
  pointer. Its deltas need an adjustment pass, listed as a task.
