## Why

Two requirements already govern the prepared caches, and the catalog build obeys
neither. `lib-store-build` makes the build prove that a prepared cache takes
effect at run time. `lib-store-provisioner` makes the preparation run through the
container path that the sandbox imports from. The build calls no preparation step
at all, thus it publishes a store with no prepared cache and no proof of one.

The move to one runtime image opened the gap. The image of the earlier design
baked the cache at build time (`images/sandbox-python/Dockerfile:194-218`), where
a comment records that `import scanpy` takes 10 to 20 minutes without it.
`per-analysis-farm-mount` removes that image, and `seed_caches` in
`sandbox-entrypoint.sh` reads the cache from the farm instead. Each consumer of
the cache is in place. The producer runs nowhere.

The removal of the `current` pointer took away the mechanism that gave the
preparation step its path. The pointer was a symlink inside the store root, thus
one bind of that root carried it into every container. Now the invoker must add a
second bind, and no invoker adds it: the acceptance checks
(`scripts/lib-store-sandbox-checks.sh`) read `/mnt/libs/current` and bind nothing
there, and `warm()` reports a warning and continues.

Three smaller defects sit beside this one. The `store-root` farm source describes
a store shape that no store has. `base-packages.json` makes a claim about the
sandbox image that nothing holds it to. The R load check runs in the provisioner
image, thus it proves that a package loads in the wrong image.

## What Changes

- The catalog build prepares the caches. The manifest gains a `warm` key that
  names the modules and the workload script, thus the workload sits beside the
  packages that it exercises. The build invocation supplies the farm bind that
  the preparation needs.
- **BREAKING** (to an invoker of the provisioner) — a preparation run with no
  farm bind at `/mnt/libs/current` fails. A cache that the run writes through
  another path never loads, thus the run produces nothing and must say so.
- The workload keeps the module set of the earlier image: `numba`, `matplotlib`,
  `scanpy`, `seaborn`, `pertpy`, `scvi`, and `cell2location`. It adds a script
  that calls into the compiled paths. An import alone leaves the numba cache
  empty, which `provision.py` records as measured.
- The acceptance checks supply the farm bind. Each sandbox section of
  `scripts/lib-store-sandbox-checks.sh` reads `/mnt/libs/current` today, and
  nothing mounts a farm there, thus no section of it can pass.
- **BREAKING** — the `store-root` farm source goes away, and `farmSource`
  becomes necessary. Its store shape had one producer, `flip_current`, which
  `per-analysis-farm-mount` deletes. No production site constructs the kind, and
  `fixed` serves a one-farm deployment better.
- A test compares `base-packages.json` against the image that it describes.
- The R load check moves into a `sandbox-base` container, thus it proves that a
  package loads in the image where a sandbox loads it. The provisioner cannot
  start a container, thus the check becomes a step of the invoker and it gates
  the catalog artifact.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `lib-store-build`: the build prepares the caches before the effectiveness
  check runs. It reads the workload from the manifest. It runs the R load check
  in the runtime image.
- `lib-store-provisioner`: a preparation run with no farm bind fails, and so does
  a run whose declared module cannot import. The R load check runs in the sandbox
  runtime image. A test compares the image-owned package list against the image.

The farm source belongs to no delta here. `per-analysis-farm-mount` introduces
that kind, and it is not archived. Thus the rename amends the delta of that
change, and it adds no requirement to the base spec.

## Impact

- `images/lib-store-manifest.yaml` — the `warm` key.
- `images/sandbox-provisioner/provision.py` — the two failures of a preparation
  run, the record of the farmed R packages, and the removal of the load check.
- `images/sandbox-provisioner/base-packages.json` — the check against the image.
- `.github/workflows/lib-store-provisioner.yml` — the preparation step and its
  farm bind.
- `scripts/lib-store-sandbox-checks.sh` — the farm bind of each sandbox section.
- `harness/src/sandbox/types.ts`, `mount-plan.ts`, `docker-client.ts`,
  `k8s-client.ts` — the name of the farm source.
- The open change `per-analysis-farm-mount` names the farm source. Its delta
  needs one adjustment pass, listed as a task.
