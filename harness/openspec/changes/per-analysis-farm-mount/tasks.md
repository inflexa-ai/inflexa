# Tasks — Per-Analysis Farm Mount

## 1. The provider seam and the mount plan

- [x] 1.1 Add the farm provider to `CreateSandboxClientConfig`: a function from analysis id to a farm location, optional for one release
- [x] 1.2 Define the farm-location type: a host path on Docker, a subPath under the store PVC on Kubernetes
- [x] 1.3 Resolve the provider at each `createSandbox` call, before the mount plan is built
- [x] 1.4 Refuse the sandbox with a named state when the provider returns no farm, in the shape of the incomplete-store refusal
- [x] 1.5 Keep the single-mount behavior when no provider is configured, so an embedder migrates in its own release

## 2. The Docker backend

- [x] 2.1 Re-target `libStoreUsable`: validate the provider's farm location for `packages.txt` and `meta.json`, and stop the read of `current`
- [x] 2.2 Add the nested read-only farm bind at `/mnt/libs/current`, ordered after the store bind
- [x] 2.3 Drop both binds together when the gate fails, and report the degradation through the diagnostics seam
- [x] 2.4 Do a backend test of the nested-bind ordering: one container, both binds, a farm file and its store target both resolve
- [x] 2.5 Do a test of the two-analyses case: two sandboxes, two farms, two versions of one package, each import resolves per farm

## 3. The Kubernetes backend

- [x] 3.1 Mount the farm subPath of the store PVC read-only at `/mnt/libs/current`
- [x] 3.2 Do a test of the pod spec: the store volume and the farm subPath mount appear together

## 4. The provisioner — pointer removal

- [x] 4.1 Remove `flip_current` and each call to it, and stop the write of `current` at publish
- [x] 4.2 Narrow the lease guard: a lease blocks a farm removal only, never an acquisition run and never a farm extension
- [x] 4.3 Warm the caches through a run-supplied bind of the target farm at `/mnt/libs/current`, and document the bind in the invoker contract
- [x] 4.4 Do a test: a publish leaves no `current` at the store root, and an old `current` is left untouched

## 5. The provisioner — parallel acquisition

- [x] 5.1 Split the whole-run flock into a shared acquisition mode and an exclusive reclaim mode on one lock file
- [x] 5.2 Move the graph append and the inventory rederive into one short commit mutex
- [x] 5.3 Make reclaim wait for zero acquisition runs and block new ones while it scans and deletes
- [x] 5.4 Do a test: two concurrent runs for two packages both complete, and the pool holds both store directories
- [x] 5.5 Do a test: two concurrent runs for one package converge on one store directory, and both report success
- [x] 5.6 Do a test: a run killed before its commit leaves unreferenced directories, and reclaim removes them

## 6. The dependency graph

- [x] 6.1 Write the emitter in the provisioner image: Python nodes and edges from the installed distribution metadata, markers evaluated in-image
- [x] 6.2 Extend the emitter with the R side: edges from `Depends`, `Imports`, and `LinkingTo` of each installed `DESCRIPTION`
- [x] 6.3 Drop edges into image-owned base packages against a fixed list, and record the list beside the emitter
- [x] 6.4 Emit `deps.json` at the store root after the CI catalog build, and append after each acquisition run under the commit mutex
- [x] 6.5 Gate the CI build: fail when an edge names a node the graph does not hold, and name the edge in the failure
- [x] 6.6 Do a test of the append: an acquisition run adds nodes and edges, and every earlier node stays byte-identical

## 7. The spec sync

- [x] 7.1 Make sure that the `preserve-farm-tracks-and-single-runtime-image` change text still holds with no pointer, and adjust its deltas where it names `current`
- [x] 7.2 Run `openspec validate per-analysis-farm-mount` and resolve each finding
