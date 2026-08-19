# Proposal: package-store-rebuild

## Why

The sandbox images bake every package. A user waits on a 10-20 GB pull, and no
user can add a package. PR #291 proved a two-container package store as a
spike, and the grill session of 2026-08-19 settled the design. The decisions
live in `docs/feat_localPackages/decisions.md` at the repository root, with
the evidence in `docs/feat_localPackages/spike_harvest/`. This change rebuilds
the capability cleanly, from those decisions.

## What Changes

- The build publishes two images. `sandbox-base` is the one runtime image,
  with no baked package. `sandbox-provisioner` has the network and the
  compilers, and it writes the store. The two variant images retire.
- A content-addressed package store lives on the host: one pool of write-once
  package directories, one symlink farm per analysis, and one dependency
  graph. An OCI bundle delivers the store through ORAS, per arch.
- **BREAKING**: `farmSource` becomes a required config field of each sandbox
  backend. The union has two kinds: `fixed` and `per-analysis`.
- A declared toolchain field gates the resolver environment and the
  orient-core prompt text. An absent field keeps the old behavior, thus a
  managed deployment adopts the feature with config values only.
- New seams and tools: `ResolveAnalysisFarm`, `ExtendAnalysisFarm`, and the
  `link_packages` sandbox tool. The planner names the packages of each step.
- The farm metadata collapses into one schema-versioned `inflexa.lock`. It
  replaces `packages.txt`, `meta.json`, `lock.json`, and the per-track
  fragments, and the mount gate reads it.
- The manifest stays the intent layer. The build resolves per arch with
  hashes, and it commits the two lock files back to the repository.
- Warming becomes one script per package, named by the manifest entry. The
  provisioner runs the scripts at catalog preparation. A per-analysis
  writable cache serves everything else.
- The provisioner entrypoint becomes subcommands, one mode each, and the spec
  names one caller per subcommand. The lease dies. The acquisition accepts a
  spec set per run, thus a host-side pending set batches the installs.
- Acquisition covers Python and R together, from CRAN and Bioconductor
  through pak. An unqualified name that both ecosystems satisfy stops with an
  ask.
- Security: the provisioner gets an egress allowlist for the pinned index
  hosts, and droast covers both Dockerfiles.
- The one domain term is **package store**. The capabilities, the workflows,
  and the scripts rename per the table in
  `docs/feat_localPackages/grill_round3.md`.

## Capabilities

### New Capabilities

- `package-store-provisioner`: the network-enabled container that writes the
  pool and the farms. The spec covers its subcommands with their callers, the
  store layout, the graph emission, the warm preparation, and the batch
  acquisition.

### Modified Capabilities

- `lib-store`: renamed to `package-store`. The store contract loses the
  `current` pointer, gains the farm-per-analysis model, the `inflexa.lock`
  farm contract, and the ecosystem-selection rules.
- `lib-store-build`: renamed to `package-store-build`. The build publishes
  two images and the OCI bundle, resolves per arch with committed locks, and
  runs per-package warm scripts with a gated cache check.
- `docker-sandbox-provider`: the mount contract changes to the two nested
  binds, the gate reads `inflexa.lock` of the resolved farm, and `farmSource`
  is required.
- `harness-sandbox-agents`: the `link_packages` tool and its prompt layer,
  gated on the bound seam.
- `planning-enhancements`: each plan step names its packages in requirement
  form, and the plan validation refuses a location.
- `sandbox-image-catalog`: the image owns the interpreters, conda at
  `/opt/conda`, and Node at `/opt/node`. The entrypoint seeds the caches. The
  baked inventory fragment joins the image contract.

## Impact

- `harness/src/sandbox/` (`types.ts`, `docker-client.ts`, `k8s-client.ts`,
  `mount-plan.ts`, `create-sandbox.ts`), `harness/src/schemas/`, `harness/src/prompts/`,
  `harness/src/tools/`, and the barrel exports.
- `images/` (two Dockerfiles, the manifest and its locks, the warm scripts),
  the three build workflows, and `droast.toml`.
- Embedders: the CLI adopts the seams in its own change, in `cli/openspec`.
  The managed service passes `farmSource` and keeps its old behavior until it
  declares the toolchain field. The K8s client changes must preserve the main
  drift: `writableTail`, `podLabels`, the owner annotation, `isAliveById`.
- Open items carried in the spec, not solved here: the managed store
  delivery (BLOCKED), and the K8s ReadWriteOnce node pin.
- The link-time both-hit ask of decision 15 defers to the CLI change,
  because the link resolution is CLI code.
