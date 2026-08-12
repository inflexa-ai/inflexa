# Per-Analysis Farm Mount

## Why

The store serves one farm to every sandbox through one `current` pointer, so all
analyses share one library set. The product moves to parallel analyses, and a
pointer that one live sandbox freezes cannot serve two closures at one time.

## What Changes

- **BREAKING** — The store contract drops the `current` symlink. The active farm
  is no longer a property of the store. It becomes a property of each sandbox.
- Each sandbox receives a second read-only bind: its analysis's farm, mounted at
  `/mnt/libs/current`, nested inside the store-root bind at `/mnt/libs`. The
  container path does not change, thus the baked `.pth`, `R_LIBS_SITE`, and the
  warm caches keep their meaning with no image change.
- The embedder supplies the farm choice for each sandbox through a provider
  seam: analysis id in, farm location out. The harness never learns the naming
  rule. When the provider gives no farm, the harness refuses the sandbox with a
  named state, the same shape as the incomplete-store refusal.
- The store usability gate re-targets: it validates the completeness markers of
  the farm the provider names, not of a store-level pointer.
- The provisioner drops `flip_current` and the pointer flip. The re-point refusal
  and its leases lose the flip job. A lease keeps one job: block a farm removal
  while a sandbox holds the store.
- The provisioner narrows its lock. Acquisition runs are parallel, because content
  addressing makes the pool writes race-safe. A short mutex covers only the
  shared-metadata commit: the dependency-graph append and the inventory rederive.
  Reclaim becomes the one exclusive writer.
- The provisioner emits a dependency graph: `deps.json` at the store root, nodes
  keyed by store-directory name, edges resolved — no version range. One emitter
  serves the CI catalog build and every later acquisition run.
- Cache preparation warms through a bind at `/mnt/libs/current`, supplied to the
  provisioner container for the run, because no host-side pointer exists anymore.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `lib-store`: the mount contract gains the per-sandbox farm bind and the
  provider seam, and it loses the store-level active pointer.
- `docker-sandbox-provider`: the Docker realization gains the nested farm bind
  and the re-targeted usability gate.
- `lib-store-provisioner`: the pointer flip and its refusal go away, and the
  lock narrows to a shared-metadata mutex with exclusive reclaim. The dependency
  graph becomes a published record. Cache preparation warms through a
  run-supplied bind.

## Impact

- `harness/src/sandbox/create-sandbox.ts` — the per-sandbox farm provider seam.
- `harness/src/sandbox/docker-client.ts` — the nested bind, `libStoreUsable`.
- `harness/src/sandbox/mount-plan.ts` — unchanged env, K8s farm subPath.
- `images/sandbox-provisioner/provision.py` — pointer removal, lock narrowing,
  the graph emitter, warm through the bind.
- The CLI embedder wires the provider and owns farm composition. That work is the
  companion change `per-analysis-farms` in `cli/openspec/changes/`.
