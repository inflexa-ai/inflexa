# The decision history of the spike branch

This document harvests the commit range `59ad83c2..origin/feat/two-container-package-store`,
which holds 105 commits, and the metadata of PR 291. The sources are the commit
messages and the PR metadata only. The harvest reads no code and no author notes.

## 1. The decision timeline

### 2026-08-03 — the prototype

- `934df36e` — divide the sandbox into two roles. The provisioner has a network
  and a compiler, and it writes the store. The sandbox has no network, and it
  reads what the provisioner wrote. A package sits on disk one time, in a
  content-addressed store. Each analysis gets a symlink farm with only its own
  closure. The harness does not change, because the store and the farms fit under
  the one `libStorePath` bind.
- `c396983e` — report the production findings. R packages move, thus R is the
  easiest language. A farm beats a long `R_LIBS_SITE`. Kubernetes is the largest
  open item, because a ReadWriteOnce claim pins each sandbox to one node. The
  report proposes a recipe schema for four hand-built R packages.
- `57e3ab5b`, `a0a211bf` — remove the build exceptions for ANCOMBC, MSstats, and
  MSstatsTMT, because Bioconductor 3.23 removed each reason. Pin DEP to a git
  commit, because the archive URL moves. Remove CVXR, because only ANCOMBC asked
  for it.

### 2026-08-04 — the R track and the provisioner

- `fe2ba966` — resolve the R track with one pak lock file. One `rlibs` stage
  replaces the cran stage and the bioconductor stage. r2u goes away, and the two
  arches use one pak path. DEP becomes a declarative `r.git` manifest entry with
  a mandatory reason. The lock is per arch, thus no lock is checked in.
- `994238de` — add the OpenSpec change as the design of record. The recipe
  schema retires, because the pak lock file is the recipe.
- `a6ec74d6` — make the provisioner prove the source of each package. The
  resolve runs with `--generate-hashes` against a pinned index. The install runs
  under `--require-hashes`. An off-index specification refuses. The commit names
  one duty of the image: an egress firewall for the pinned index host.
- `50093709` — move the provision program into `images/sandbox-provisioner`. The
  build asserts that its base digest equals the `base_image` of the manifest,
  thus no drift gives a mismatched ABI.
- `eb768f93`, `df5079d1`, `48c4de3f` — repair an abandoned staging tree at the
  start of each run. Stop the resolve when the closure holds an off-index entry,
  which the earlier code dropped in silence. Refuse a store root that is not the
  sandbox mount, thus a farm link cannot dangle in the sandbox.
- `1d7a2a06` — seed the prepared caches in the sandbox entrypoint. numba and
  matplotlib probe a directory with a write, and a read-only store fails that
  probe. Thus the entrypoint copies the caches to writable paths under /tmp.
- `7dc7d941` — provision the R track into the store. Task 6.6 stays open as a
  TODO: the R load-check helper is inline in a Dockerfile.
- `d9cf9816` — add the store lock, the `current` pointer flip, the mount lease,
  and reclamation. `flip_current` refuses a move under an active lease, and
  `--force-repoint` covers a stale lease. The lease operations are the seam for
  the host.

### 2026-08-05 — tests, live-run fixes, and the GHCR decision

- `702fea5d` — correct the agent text. An install is not impossible: a host
  action adds a package, and a later sandbox sees it.
- `9b483181` — build the store in its own workflow, beside the track tarballs.
  An untouched `lib-store.yml` makes the two-forms rule a fact of the structure.
  The GHCR publish, the cache warm-up, and the store-image comparison stay out
  of scope.
- `051f039f`, `1cb5cda2`, `4fffcee7` — add the unit suite, the container rig,
  and the hard cases. The rig keeps the R track out, because a pak build takes
  tens of minutes.
- `e0de236d` — keep the records of a farm when a run stops early. `build_farm()`
  removed the whole farm, and the run wrote the records only at the end. A
  refused re-point then destroyed the record of the farm.
- `cb52d720`, later `58a552ce` — make the farm publish crash-atomic with a
  staging swap. The swap then dangled each absolute hoisted link, thus each
  hoisted link becomes relative.
- `26611c0a` — read the Bioconductor release from the pak lock, not from
  BiocManager. The BiocManager map is a claim about a table. The lock names
  where each package truly came from, and the value becomes a list.
- `b9a88e93` — reconcile task 9.7 with task 9.5. No published directory is
  partial, and the staging debris is the repair case.
- `9eff04dd`, `5ba41b92`, `7fff586e` — record the roadmap. The store publishes
  to GHCR as an OCI artifact. The tarballs stay only for the managed mount,
  until Phase 5 replaces them. Two CLI changes cover the mount and the download.

### 2026-08-06 — the publish, the CLI mount, and the download gate

- `7037d7bf` — record the warm workload and its script hash in the lock, thus a
  replay runs the same bytes. An R load check runs after the farm assembly.
- `368904a0`, `ad93a3d7`, `2360eb97` — add the sandbox acceptance rig. Publish
  the store to GHCR with an immutable version tag. Archive the change.
- `3998e69b` — mount a configured store root as `libStorePath`. The inventory
  follows the mount. An unusable store falls back to the image cache, with a
  warning.
- `20630260`, `209ee724` — add the store command family. The provisioner image
  comes from explicit configuration, with no default. The guide records the
  opt-in keys. The image-source decision archives as BLOCKED.
- `cbffe0fe`, `19ca195a`, `befbbce2` — pull the store from GHCR with a receipt.
  The stage activates with `current` last. Each sandbox action holds at a gate
  until the receipt reports a complete store, and the first download asks with
  the size.

### 2026-08-07 — ownership, the mandatory store, and the detached download

- `0f6a47f2` — make the store root a CLI-owned constant, with a boolean opt-in.
  A download merges into the store, thus it never removes a user-provisioned
  package.
- `092d84ed`, `25f687fa` — keep each farm track that a run does not rebuild.
  sandbox-base becomes the only runtime image, and the two baked variants
  retire. The store holds packages only.
- `0e8cd85a`, `6aefa87a` — make the store mandatory, because no image bakes a
  library. The opt-in and the provisioner-image key leave the configuration.
  `inflexa store use` switches the active farm with an atomic rename.
- `5e6175ac`, `d888be05`, `95796eaf`, `c0fa58b7`, `e826a269` — move the
  download to a detached process that `inflexa setup` starts. One database row
  carries the state. The app starts no download, and the harness boot does not
  depend on the store. A cancel command and an image-removal command join.

### 2026-08-10 — the image tracks, six decisions, and R fixes

- `7bff313b`, `565c150a` — bake an inventory fragment of the image tracks, and
  merge it with the farm readout. The managed tarballs retire. The `--sandbox`
  answer becomes a bare flag. The CLI caches the fragment for each digest.
- `e60913c4`, `f1688147` — resolve the six open decisions, and sync the deltas.
  Acceptance is the validation, and reclaim is the removal path.
- `471a64c4`, `74ea01f4` — publish the provisioner image beside sandbox-base in
  lockstep. Pass TARGETARCH explicitly, because one builder left it empty.
- `46cbe6c6`, `11611a4f`, `78524ab5` — add a push trigger for the store build on
  this branch, with two sentinel touches. The trigger must go before the merge.
- `361bcef0` — nest an R package inside its store directory. Rfast rebuilds its
  own path as libname plus name, and a flat directory broke that path.
- `56d4137f` — validate imports from dist metadata, and load R namespaces. An
  attach of 753 packages made conflicted trip on a pseudo-export.

### 2026-08-12 — the per-analysis pivot

- `37a781a9`, `021c144d` — refuse a store layer that did not extract whole,
  because tar exited 0 on a damaged archive. Carry a farm track forward by link,
  because copytree failed on virtiofs listxattr.
- `72be27cf` — specify the per-analysis farm mount. One live sandbox froze the
  library set of every other analysis. The farm becomes a property of each
  sandbox, as a second read-only bind at `/mnt/libs/current`. The provisioner
  loses the pointer flip and publishes a resolved dependency graph.
- `63759759`, `f7f039f2` — make `inflexa store add` a pure acquisition, with one
  flight for each specification. Remove `flip_current`. The lock divides into a
  shared acquisition mode and an exclusive reclaim mode. The staging directory
  becomes per run, thus concurrent runs delete no tree in flight. `emit_deps.py`
  publishes `deps.json`, and a gate fails a dangling edge.
- `07441b19`, `7303ab75` — mount the farm of the analysis through
  `resolveAnalysisFarm`. Then `FarmSource` names the three deployments, because
  `undefined` carried two meanings. A refusal now carries the reason of the
  embedder.
- `eda792d5`, `63f92851`, `5e5763e6` — compose a farm on the host from the pool,
  with a golden parity fixture against the provisioner. Composition is lazy at
  the first sandbox action. The flight cap defaults to 2, because an R compile
  can exhaust the memory.
- `f74241ea` — merge a shared top-level name across two distributions, and
  refuse only two versions of one distribution. The composer refused the shape
  of the published catalog, and the provisioner merged it in silence. The two
  builders now agree.
- `4a9e9639`, `fe518674` — drop `LinkingTo` from the edge set, because it is a
  build-time field and the gate made each edge a requirement. Name pak in the
  manifest, because devtools imports it and the provisioner image masked it.
- `d1b871c7` — make the default farm a copy of the template, not a closure walk.
  A marker under an extra gave no edge, thus a walk lost 16 distributions and
  `import scanpy` failed.
- `69809b6c`, `164f2676` — name `--update` when the store predates the graph.
  Align the acceptance checks with the store that has no pointer.

### 2026-08-13 — the compat rule and the warm-cache build

- `152a6fa8` — read a marker with packaging, not with a parser of the emitter.
  The recorded reason for the parser was false, and a wrong parse is silent.
- `cd84ad12`, `36f510bd` — add the rule for backward compatibility: unmerged
  work constrains nothing. Record why composition takes no store lock: a default
  farm links exactly what the template links, thus reclamation sees each
  directory as referenced.
- `567757a5`, `00c3484a` — specify the warm cache and the farm source. Then
  remove the `store-root` kind and make `farmSource` mandatory, as a BREAKING
  change, because nothing produces the in-store `current` that the kind read.
- `a34e9668`, `00e0f68c` — declare the warm workload in the manifest, with calls
  and not imports, because numba keys an entry on a call signature. Remove uv
  from the image-owned list, because the image owns the command and not the
  distribution.
- `fae4cfcf`, `9de58984`, `ce1101ca` — gate a preparation run through the bind,
  and record a measurement. A run that builds a farm cannot warm it, because the
  publish replaces the bound directory. The R load check moves into the sandbox
  image, because a check in the provisioner image proves the wrong image.
- `bcaad191`, `fc5fe487`, `f8231f2f`, `97c56c9f` — prepare the catalog caches in
  CI and prove both farms. The `timeout-minutes` value stays provisional. Remove
  the mount-point debris that shipped a `current` entry the contract denies.
  Archive the warm-cache change.

### 2026-08-14 — agent-requested packages

- `5858ba44`, `a65916f9` — specify the farm-extension seam and the
  `link_packages` tool. The planner names the packages of each step. The farm
  becomes empty at its creation, because the planner runs before any sandbox
  action. The graph gains a version ordering, because the host holds no
  comparator.
- `59553ebf` — order the graph with `by_name`, newest first, at schema version
  2. A preparation run writes into one shared cache home. An acquisition warms
  what it acquired.
- `0abfb562`, `6e684528` — add the seam and the tool in the harness, in the
  always-on substrate and not the closed allowlist. An outcome says whether an
  acquisition of that ecosystem is possible. Each step schema carries a
  `packages` set, and `validate_plan` refuses a location by its shape.
- `3d4f1d83` — record the task state. Task 7.4 stays an open decision: nothing
  refuses a preparation of a farm other than the catalog.
- `d34e588e`, `d07c18da` — run the effectiveness check through the entrypoint,
  because `seed_caches` is the only code that makes a cache reach a workload.
  Then move the seed into a file that the entrypoint sources, because an
  entrypoint switch put an arbitrary command on the sandbox boundary.

### 2026-08-18 — the final turn

- `3918cd13` — make an acquisition warm nothing, because a numba entry keys on a
  call signature and an import gives none. A preparation run refuses each farm
  but the catalog. The graph keeps schema version 1, because a reader ignores an
  unknown field.
- `09d5ff1f` — resolve a request from the `by_name` ordering. The catalog
  default goes, and `composeFarm` with it. `extendFarm` becomes the one writer,
  and each farm starts empty.
- `f80d9086`, `f80c1300`, `bf35f714` — add `store link`, and make each caller of
  a flight extend its own farm. `analysis new` makes the farm with the analysis.
  A plan links its packages before the launch, and a pool miss refuses the run.
  The harness names no remedy, because a managed deployment holds no `inflexa`
  binary.
- `158ac842`, `037451e2` — sync the specs with the decisions of the session.
  Append the bin of the farm at the end of the sandbox PATH, thus a farm script
  never shadows an image tool.
- `27bc068b` — specify the per-analysis warm cache for the two subsystems. The
  cache is per analysis, because a .nbc file is machine code and a shared home
  would let one analysis plant code for another.

## 2. Reversals

1. The active-farm pointer. `d9cf9816` added `current`, `flip_current`, the
   lease guard, and `--force-repoint`. `72be27cf` and `f7f039f2` removed the
   pointer. Reason: one live sandbox froze the library set of every other
   analysis.
2. The `inflexa store use` command. `6aefa87a` added the farm switch.
   `63759759` and `5e5763e6` removed it, because no active farm was left to
   switch.
3. The lease meaning. `d9cf9816` made the lease guard the re-point. `f7f039f2`
   kept one job: the lease blocks only the removal of the farm that it names.
4. The store opt-in and the configured root. `3998e69b` read a configured store
   root. `0f6a47f2` made the root a constant with a boolean opt-in, thus no
   configuration value can move the store. `0e8cd85a` and `6aefa87a` removed the
   opt-in, because no image bakes a library.
5. The provisioner-image configuration key. `20630260` asked for explicit
   configuration with no default. `0e8cd85a` and `6aefa87a` made the image a
   constant that setup pulls.
6. The in-command download. `19ca195a` asked at the gate and downloaded in the
   app. `5e6175ac` and `95796eaf` made the download a detached process, and the
   app starts no download.
7. The managed tarballs. `5ba41b92` kept them for the managed mount.
   `7bff313b` and `e60913c4` retired them, because the managed delivery is
   decoupled.
8. The recipe schema. `c396983e` proposed it for the hand-built R packages.
   `994238de` retired it, because the pak lock file is the recipe.
9. The R build mechanisms. The build used r2u, BiocManager, and a shell
   `install_git` branch. `fe2ba966` replaced the three with one pak lock.
10. The Bioconductor version source. `7dc7d941` recorded `bioc_version` from
    BiocManager. `26611c0a` read `bioc_releases` from the pak lock, because the
    BiocManager map is a claim about a table and the value must be a list.
11. The R store layout. `7dc7d941` stored a flat package directory. `361bcef0`
    nested the package, because Rfast rebuilds its path as libname plus name.
12. The R load check location. `7037d7bf` ran it in the provisioner run.
    `fae4cfcf` and `9de58984` moved it into the sandbox image, because pak in
    the provisioner image satisfied a dependency that the sandbox lacks
    (`ce1101ca`).
13. The R check mode. The check attached each package. `56d4137f` loads each
    namespace instead, because an attach of 753 packages tripped conflicted.
14. The farm record order. `934df36e` wrote the records at the end and removed
    the whole farm. `e0de236d` wrote the records before the re-point.
    `cb52d720` made the publish a crash-atomic staging swap.
15. The hoisted link shape. The staging swap of `cb52d720` dangled each
    absolute link. `58a552ce` made each hoisted link relative.
16. The top-level-name rule. `eda792d5` refused a shared name with two
    `__init__.py` files, and the provisioner merged it in silence. `f74241ea`
    merges two distributions and refuses only two versions of one distribution.
17. The default farm content, two times. `63f92851` walked the closure of the
    template roots. `d1b871c7` copied the template links, because extras markers
    lost 16 distributions. `a65916f9` and `09d5ff1f` removed the default: a
    farm starts empty, and the plan names its packages.
18. The composition moment. `63f92851` composed at the first sandbox action.
    `a65916f9` and `f80c1300` make the farm with the analysis, because the
    planner is necessary before any sandbox action.
19. The optional farm seam. `07441b19` and `7303ab75` kept a `store-root`
    compatibility path. `00c3484a` removed the kind and made `farmSource`
    mandatory, because nothing produces the in-store `current` that the kind
    read. `cd84ad12` names the fault class.
20. The `LinkingTo` edge. `f7f039f2` read it into the edge set, under the claim
    that over-inclusion is harmless. `4a9e9639` removed it, because the gate
    made each edge a requirement and 4 of 5 dangling edges came from it.
21. The marker parser. The emitter held a hand parser, with the recorded reason
    that the image lacks packaging. `152a6fa8` replaced it with packaging,
    because the reason was false and a wrong parse is silent.
22. The acquisition warm. `5858ba44` and `59553ebf` warmed what an acquisition
    acquired. `3918cd13` removed the warm, `extend_farm`, and `bound_farm`,
    because a numba entry keys on a call signature and an import gives none.
23. The graph schema version. `59553ebf` moved to version 2. `3918cd13` kept
    version 1, because `by_name` is only a new field that a reader can ignore.
24. The check entry path. `d34e588e` gave the entrypoint a switch. `d07c18da`
    moved the seed into a sourced file, because a switch put an arbitrary
    command on the sandbox boundary.
25. The in-run warm-up. `e0de236d` ran the warm-up after the re-point in the
    same run. `fae4cfcf` made the preparation a separate run, because the
    publish replaces the directory that the bind holds.
26. The tool allowlist. Task 4.1 named a closed allowlist. `0abfb562` and
    `3d4f1d83` put `link_packages` in the always-on substrate, because the
    allowlist gave a composition error to an embedder that binds no seam.
27. The download installed-state key. `cbffe0fe` keyed on `current`.
    `5e5763e6` keyed on `store/` and `farms/`, because the download writes no
    `current`.
28. The acceptance assertions. The checks asserted the pointer contract.
    `164f2676` and `f8231f2f` assert the pointer-free contract, and `f8231f2f`
    removed a mount-point entry that held a stale assertion green.
29. The preparation guard. `3d4f1d83` recorded that nothing refuses a
    preparation of a non-catalog farm. `3918cd13` added the refusal, thus the
    record stays beside the entries.

## 3. Abandoned paths

- The recipe schema for R build code (`c396983e`, retired in `994238de`).
- r2u as the CRAN installer, and the two-stage R build (`fe2ba966`).
- CVXR in the manifest (`a0a211bf`).
- The active-farm pointer, `flip_current`, and `--force-repoint` (`d9cf9816`,
  removed in `f7f039f2`).
- The `inflexa store use` command (`6aefa87a`, removed in `5e5763e6`).
- The store opt-in and the configured store root (`3998e69b`, removed through
  `0f6a47f2` and `6aefa87a`).
- The per-language baked image variants (`25f687fa` retires them).
- The managed track tarballs (`5ba41b92`, retired in `7bff313b`).
- The `store-root` farm source kind (`7303ab75`, removed in `00c3484a`).
- The hand parser of a PEP 508 marker (`152a6fa8` replaces it).
- The layer pump through the JS bridge (`37a781a9` replaces it with a temporary
  file).
- The copytree carry-forward of a farm track (`021c144d` replaces it with
  links).
- The catalog-default composition and `composeFarm` (`d1b871c7`, removed in
  `09d5ff1f`).
- The acquisition warm, with `extend_farm` and `bound_farm` (`59553ebf`,
  removed in `3918cd13`).
- The entrypoint switch for the effectiveness check (`d07c18da` removes it).

## 4. Open threads

- The branch push trigger of the store build. `46cbe6c6` says "Remove the
  trigger before the merge to main". No later commit removes it.
- The egress firewall of the provisioner image. `a6ec74d6` names it a duty of
  the image. No later commit reports it.
- The `timeout-minutes` value of the catalog build. `bcaad191` calls it
  provisional, and `fc5fe487` keeps a task open for the first real run.
- The Kubernetes node pin. `c396983e` names a ReadWriteOnce claim as the
  largest open item. `07441b19` adds the subPath mount, but no commit resolves
  the pin.
- The per-analysis warm cache. `27bc068b` specifies it, records an accepted
  loss under concurrent writers, and records a residual risk. No implementation
  commit follows in this range.
- The R acquisition gap. The PR comment of 2026-08-14 records that
  `inflexa store add` acquires Python only, out of scope by decision. No later
  commit adds an R acquisition.
- The pre-branch upgrade paths. `cd84ad12` names an upgrade path for an old
  store as a fault. `69809b6c` and `5e5763e6` hold such paths, and no later
  commit removes them.
- The CI-marked tasks. `2360eb97` archives the change with four tasks that only
  the manual dispatch on main covers.

## 5. The reviews and the comments

The PR holds four reviews. Each review has an empty top body, and the substance
sits in one inline comment.

1. github-code-quality[bot], 2026-08-03, on `acceptance.py:102`. An unused
   variable `ext`. Only `934df36e` touches that file in this range, thus no
   commit addressed it.
2. vivere-dally, 2026-08-12 16:31, on `create-sandbox.ts`. One question:
   "Does the managed solution need the farm concept?"
3. vivere-dally, 2026-08-12 17:44. The answer: yes for the concept, no for
   per-analysis composition. The real seam is the store layout, because the
   provisioner no longer writes `current`. The comment also flags that
   `undefined` carries two meanings, and proposes a named union.
4. vivere-dally, 2026-08-12 18:02. The union landed in this PR as `FarmSource`,
   in `7303ab75`. `00c3484a` then removed the `store-root` kind and made the
   source mandatory.

The PR holds three issue comments.

1. vivere-dally, 2026-08-03: "@claude review". A trigger only.
2. claude, 2026-08-03. Three findings:
   - The unused variable, the same as the bot. No commit addressed it.
   - A staging race. The name alone keys `.staging/<name>`, thus two concurrent
     installs can remove each other's tree. `d9cf9816` serialized the writers
     with the store lock, and `f7f039f2` made the staging directory per run.
   - The provisioner runs at default container privilege, with no note on the
     asymmetry. No commit addressed this finding.
3. vivere-dally, 2026-08-14. The R track cannot be extended after the catalog
   build, recorded as out of scope by decision. The comment asks for a refusal
   with its own reason, thus an agent does not retry a request that cannot
   succeed. `0abfb562` gives that shape: an outcome says whether an acquisition
   of that ecosystem is possible. The R acquisition itself stays open.

## 6. The vocabulary map

- **store** — `934df36e`. The content-addressed directory that holds one copy
  of each package version. The meaning stays stable.
- **farm** — `934df36e`. A symlink directory that holds the closure of one
  analysis. The meaning drifted. It was an active farm under a pointer
  (`d9cf9816`). It became a property of each sandbox (`72be27cf`). It now
  starts empty when the analysis starts (`a65916f9`, `f80c1300`).
- **provisioner** — `934df36e`. The container with a network and a compiler
  that writes the store.
- **current** — `934df36e` as the container path, `d9cf9816` as an in-store
  pointer with a flip. The meaning drifted: `72be27cf` keeps the container path
  but makes it a per-sandbox bind, and `f7f039f2` deletes the pointer.
- **warm** — `934df36e` ("warmed entries"). A prepared numba or matplotlib
  cache. The meaning drifted: a warm-up inside the provisioning run
  (`e0de236d`), then a separate preparation run (`fae4cfcf`), then an
  acquisition warm (`59553ebf`) that `3918cd13` removed.
- **lease** — `d9cf9816`. A record that a sandbox mounts the store, and a guard
  on the re-point. `f7f039f2` narrowed it: it blocks only the removal of the
  farm that it names.
- **flight** — `63759759`. One shared in-progress acquisition for one
  normalized specification. `f80d9086` set the `::` key and made each caller
  extend its own farm.
- **pool** — `63759759`. The store content seen as the source that a
  composition links from. `f7f039f2` says a run "acquires into the pool".
- **graph** (`deps.json`) — `72be27cf`, published in `f7f039f2`. The resolved
  dependency graph at the store root, with exact edges and a gate on a dangling
  edge.
- **ordering** (`by_name`) — `5858ba44`, emitted in `59553ebf`. The per-name
  newest-first list, thus the host compares no versions. The schema version
  drifted from 2 back to 1 (`3918cd13`).
- **template** (the catalog farm) — `eda792d5`, `5e5763e6`. The farm that the
  download delivers. The meaning drifted: the source of the default content
  (`d1b871c7`), then the holder of the shared cache home only (`09d5ff1f`).
- **catalog** — `95796eaf`. The published package set that the download
  transfers.
- **track** — `fe2ba966`, `7dc7d941`. A language subtree of the store: python,
  r/cran, r/bioconductor, r/github. `7bff313b` extends it to the two image
  tracks.
- **receipt** — `7fff586e`, `cbffe0fe`. The download record that holds the
  manifest digest.
- **acquisition** — `72be27cf`, `63759759`. An install into the pool, with no
  farm work.
- **composition** — `63759759`, `eda792d5`. The host-side assembly of a farm
  from the graph. `09d5ff1f` removed `composeFarm`, and `extendFarm` became the
  one writer.
- **seam** — `d9cf9816` for the lease operations, then the farm provider seam
  (`72be27cf`, `7303ab75`) and the farm-extension seam (`5858ba44`,
  `0abfb562`).
- **preparation run** — `fae4cfcf`. A run that warms a published farm through
  the bind and records a measurement.
- **farm source** — `7303ab75`. The named union of the three deployments.
  `00c3484a` removed the `store-root` member.
- **bundle** — the term appears in no commit body of this range.
