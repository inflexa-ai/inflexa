# Harness harvest — PR #291 (`feat/two-container-package-store`)

This document reports what the code does in two states. "Main today" is the
working repo at `origin/main`. "Spike HEAD" is the worktree of PR #291. A
`spike:` prefix marks a reference into the spike worktree.

The spike branched from `59ad83c2`, and main moved after that point. Thus some
differences between the two states are main drift, not spike work. The
document marks those.

## 1. Capabilities and seams

### Main today

- The lib store is an optional path or PVC: `libStorePath`
  (`harness/src/sandbox/docker-client.ts:82`) and `libStorePvc`
  (`harness/src/sandbox/create-sandbox.ts:105`). No farm concept exists.
- The discovery tools are `list_available_packages`
  (`harness/src/tools/sandbox/list-available-packages.ts:206`) and
  `list_available_refs`. No `link_packages` tool exists
  (`harness/src/tools/sandbox/index.ts:1-8`).
- The planner gives prose guidance on installed packages only
  (`harness/src/prompts/planner.ts:111-122`). A plan step carries no package
  field (`harness/src/schemas/plan-schemas.ts:24`).
- Main-only drift, absent from the spike:
  - `writableTail` and `podLabels` on `CreateSandboxMeta`
    (`harness/src/sandbox/types.ts:245`, `:249`)
  - `sandboxWriteTail` (`harness/src/sandbox/mount-plan.ts:133`)
  - the K8s owner annotation and the pod attribution labels
  - `isAliveById` on the backend ops
    (`harness/src/sandbox/docker-client.ts:264`)
  - `transport` on the client (`harness/src/sandbox/create-sandbox.ts:246`)

### Spike HEAD

- **`FarmSource`** — the farm-choice seam. It is a union of `fixed` (one farm
  for every analysis) and `per-analysis` (a resolver function)
  (`spike:harness/src/sandbox/types.ts:264`). The embedder realizes it. It is a
  **necessary** field of `CreateSandboxClientConfig`
  (`spike:harness/src/sandbox/create-sandbox.ts:85`), `DockerClientConfig`
  (`spike:harness/src/sandbox/docker-client.ts:91`), and `K8sClientConfig`
  (`spike:harness/src/sandbox/k8s-client.ts:110`). Each backend calls it at
  each `createSandbox`, through `farmProviderOf`
  (`spike:harness/src/sandbox/mount-plan.ts:182`,
  `spike:harness/src/sandbox/docker-client.ts:299`,
  `spike:harness/src/sandbox/k8s-client.ts:529`).
- **`ResolveAnalysisFarm`** and **`FarmResolution`** — the analysis id in, a
  farm location or an `unavailable` state with a reason out
  (`spike:harness/src/sandbox/types.ts:246`, `:237`). An `unavailable` result
  refuses the one sandbox with the new `farm_unavailable` error
  (`spike:harness/src/sandbox/sandbox-error.ts:80`,
  `spike:harness/src/sandbox/docker-client.ts:318`).
- **`ExtendAnalysisFarm`** — the farm-extension seam: an analysis id and
  `PackageRequest[]` in, one `PackageRequestOutcome` for each request out
  (`spike:harness/src/sandbox/types.ts:345`). The outcomes are `linked`,
  `present`, `absent` with `acquisitionPossible`, and `collision`
  (`spike:harness/src/sandbox/types.ts:292-327`). The harness declares no
  realization (`spike:harness/src/sandbox/types.ts:341-344`). The embedder
  binds it. Three consumers call it:
  - the `link_packages` tool of a sandbox agent
    (`spike:harness/src/tools/sandbox/link-packages.ts:121`)
  - the pre-launch link pass of `execute_analysis`
    (`spike:harness/src/tools/execute-analysis.ts:168-182`)
  - nothing else. The seam acquires nothing and starts no container
    (`spike:harness/src/tools/sandbox/link-packages.ts:5-8`).
- **`link_packages`** — a new sandbox tool. It exists only when the embedder
  binds the seam, and no `meta.tools` allowlist names it
  (`spike:harness/src/agents/sandbox/shared.ts:333`). The seam rides as an
  optional field of `SandboxAgentDeps`
  (`spike:harness/src/agents/sandbox/shared.ts:151`) and of
  `ConversationAgentDeps`
  (`spike:harness/src/agents/conversation-agent.ts:155`).
- **Seam threading gap**: no file under `spike:harness/src/workflows/` or
  `spike:harness/src/runtime/` names `extendAnalysisFarm` (grep). The workflow
  path reaches a sandbox agent only through the embedder-supplied `buildAgent`
  closure (`spike:harness/src/workflows/sandbox-step.ts:290`,
  `spike:harness/src/runtime/assemble.ts:56`). Thus the embedder must thread
  the seam into that closure itself, or a step agent never holds the tool.
- **Planner packages** — `PlanStepSchema` requires a `packages` array on each
  planned step (`spike:harness/src/schemas/plan-schemas.ts:24`). The
  persistence schema keeps it optional
  (`spike:harness/src/schemas/workflow-state.ts:51`). `validatePlan` refuses an
  entry that is not a requirement, with a name-and-version grammar
  (`spike:harness/src/schemas/validate-plan.ts:47`, `:175-187`).
- The barrel exports the seam types
  (`spike:harness/src/index.ts:401-409`).

## 2. The mount contract

### Main today

- The Docker binds are: the analysis tree read-only at `/{analysisId}`, the
  write tail read-write, the lib store read-only at `/mnt/libs`, and the ref
  store read-only at `/mnt/refs`
  (`harness/src/sandbox/docker-client.ts:313-320`).
- **The gate**: `libStoreUsable(libStorePath)` resolves the store-root
  `current` symlink with `statSync`. It requires that `current` resolves to a
  directory which holds `packages.txt` and `meta.json`
  (`harness/src/sandbox/docker-client.ts:126-135`). The gate runs again at each
  `createSandbox` call (`harness/src/sandbox/docker-client.ts:286`). A failed
  gate skips the libs mount, logs a warning, and the sandbox degrades to
  `available:false` (`harness/src/sandbox/docker-client.ts:287-292`).
- `refStoreUsable` does a check of directory existence only, with `lstatSync`,
  and it rejects a symlink (`harness/src/sandbox/docker-client.ts:153-159`).
- **What the sandbox sees**: `/{analysisId}` read-only, the step directory or
  the declared tail read-write, `/mnt/libs` with the store's own `current`
  symlink inside it, and `/mnt/refs`
  (`harness/src/sandbox/mount-plan.ts:33-41`, `:184-205`). The bind source is
  the store root. Thus the container resolves `current` through the store's
  live symlink, and only the gate at `createSandbox` time pins it.
- **K8s**: the session PVC mounts through `subPath` pairs from
  `buildSessionSubPaths` (`harness/src/sandbox/mount-plan.ts:159-170`). The
  libs PVC mounts whenever `libStorePvc` is set, with no usability gate
  (`harness/src/sandbox/k8s-client.ts:181`).
- **Concurrent analyses on main**: each analysis has its own workspace root
  through `resolveWorkspaceRoot(analysisId)`
  (`harness/src/sandbox/docker-client.ts:307`). Each step gets its own
  sandbox, one for each step
  (`harness/src/sandbox/create-sandbox.ts:224-228`). But every sandbox of
  every analysis mounts the same store, and the one `current` pointer selects
  one package set for all of them
  (`harness/src/sandbox/mount-plan.ts:176-181`,
  `harness/openspec/specs/lib-store/spec.md:29-36`).

### Spike HEAD

- **Farm resolution comes first**. The provider runs only when `libStorePath`
  is set (`spike:harness/src/sandbox/docker-client.ts:299`). A thrown provider
  or an `unavailable` result refuses the `createSandbox` call with
  `farm_unavailable` (`spike:harness/src/sandbox/docker-client.ts:308-318`).
- **The gate re-targets**: `libStoreUsable(farmPath)` requires that the farm
  the provider names is a directory with `packages.txt` and `meta.json`. It
  does not resolve a `current` symlink at the store root
  (`spike:harness/src/sandbox/docker-client.ts:127-148`).
- **Two nested binds**: the store root read-only at `/mnt/libs`, then the farm
  read-only at `/mnt/libs/current`. The farm bind comes after the store bind,
  and the array order pins the nesting
  (`spike:harness/src/sandbox/docker-client.ts:351-362`). The farm path is the
  constant `FARM_CONTAINER_PATH = /mnt/libs/current`
  (`spike:harness/src/sandbox/mount-plan.ts:32`).
- A store with an unusable farm drops **both** mounts and logs a warning
  (`spike:harness/src/sandbox/docker-client.ts:325-331`).
- **K8s**: the farm is a `subPath` of the same lib-store PVC, mounted at
  `/mnt/libs/current` after the store mount
  (`spike:harness/src/sandbox/k8s-client.ts:251-263`). K8s does no check of
  the farm interior. Only the `unavailable` resolution refuses
  (`spike:harness/src/sandbox/k8s-client.ts:544-548`).
- The per-analysis **cache mount** at `/mnt/libs/cache` exists in a spec delta
  only. The code has no cache path
  (`spike:harness/src/sandbox/mount-plan.ts:54-81`,
  `spike:harness/openspec/changes/per-analysis-cache-mount/specs/lib-store/spec.md`).

## 3. PATH and the runtime environment

### Main today

When the store is mounted, the mount plan emits: `R_LIBS_SITE` over three store
paths, `NODE_PATH=/mnt/libs/current/node/node_modules`, and a `PATH` that ends
with `/mnt/libs/current/conda/bin`
(`harness/src/sandbox/mount-plan.ts:176-182`). `PYTHONPATH` stays unset. A
`.pth` file in the store resolves Python
(`harness/src/sandbox/mount-plan.ts:173-175`).

### Spike HEAD

- `R_LIBS_SITE` keeps the three farm paths under `/mnt/libs/current`
  (`spike:harness/src/sandbox/mount-plan.ts:142`).
- `NODE_PATH` moves to the image path `/opt/node/node_modules`
  (`spike:harness/src/sandbox/mount-plan.ts:143`).
- `PATH` changes twice: the conda entry moves to the image path
  `/opt/conda/bin`, and `${FARM}/python/bin` appends at the **end**
  (`spike:harness/src/sandbox/mount-plan.ts:144`). The comment states the
  reason: a farm hoists console scripts into its `bin`, and the image paths
  come first so a farm script never shadows an image tool
  (`spike:harness/src/sandbox/mount-plan.ts:129-139`).
- The env still emits only when the libs mount is live
  (`spike:harness/src/sandbox/mount-plan.ts:166`). Docker injects it as
  container `Env` (`spike:harness/src/sandbox/docker-client.ts:381`), and K8s
  injects it into the pod spec (`spike:harness/src/sandbox/k8s-client.ts:194`).

## 4. Managed-service exposure

Each item below reaches a K8s embedder. The second column of each item states
the behavior when the new package-store config is absent.

1. **`farmSource` is a necessary config field.** A K8s composition root that
   passes none fails to compile
   (`spike:harness/src/sandbox/create-sandbox.ts:85`,
   `spike:harness/src/sandbox/k8s-client.ts:110`). With `libStorePvc` unset the
   provider never runs, and behavior is unchanged
   (`spike:harness/src/sandbox/k8s-client.ts:529`).
2. **The farm mount on K8s.** With `libStorePvc` set, every sandbox gains a
   second read-only mount at `/mnt/libs/current`, a PVC `subPath` from the
   provider (`spike:harness/src/sandbox/k8s-client.ts:256-263`). An
   `unavailable` resolution refuses the `createSandbox` call
   (`spike:harness/src/sandbox/k8s-client.ts:544-548`). K8s does no check of
   the farm interior.
3. **The resolver env changes for every store-mounted sandbox, both
   backends.** `PATH` loses `/mnt/libs/current/conda/bin` and gains
   `/opt/conda/bin` plus the farm `python/bin`. `NODE_PATH` moves to
   `/opt/node/node_modules` (`spike:harness/src/sandbox/mount-plan.ts:140-146`).
   Under the current three-image ladder, conda lives inside the store at
   `/mnt/libs/current/conda`
   (`harness/openspec/specs/lib-store-build/spec.md:110-122`). Thus a managed
   deployment on the current images loses its conda tools from `PATH` until it
   moves to the new single `sandbox-base` image. No new config gates this.
4. **The planner must name packages.** `PlanStepSchema` requires `packages` on
   every planned step (`spike:harness/src/schemas/plan-schemas.ts:24`), and the
   planner prompt instructs it (`spike:harness/src/prompts/planner.ts:124-136`).
   This is unconditional. A stored plan without the field still parses
   (`spike:harness/src/schemas/workflow-state.ts:46-58`).
5. **`validatePlan` gains rule 7.** It refuses a package entry that names a
   path, a URL, or a store directory
   (`spike:harness/src/schemas/validate-plan.ts:175-187`). It runs on stored
   plans at each launch
   (`spike:harness/src/tools/execute-analysis.ts:226-232`). An absent
   `packages` array passes (`spike:harness/src/schemas/validate-plan.ts:181`).
6. **The pre-launch link pass in `execute_analysis`.** It links the union of
   the plan's packages before the run reserves anything, and a refusal throws
   `PlanPackagesUnavailableError`
   (`spike:harness/src/tools/execute-analysis.ts:168-182`, `:145-153`,
   `:336-340`). Without a bound seam the pass returns at once
   (`spike:harness/src/tools/execute-analysis.ts:169`).
7. **`link_packages` and its prompt layer.** Both exist only when the seam is
   bound (`spike:harness/src/agents/sandbox/shared.ts:309-313`, `:333`).
   Without the seam, no tool and no layer exist.
8. **The orient-core prompt text changes for every sandbox agent.** The
   section becomes "No Network, No Runtime Installs", and it tells the agent
   that an acquisition is a host action
   (`spike:harness/src/prompts/sandbox-standards.ts:99-108`). Unconditional.
   This also breaks the byte-identity of the cached prompt prefix against main.
9. **`list_available_packages` merges an image fragment.** It reads
   `/opt/inflexa/image-packages.txt` by default and merges it into the store
   inventory (`spike:harness/src/tools/sandbox/list-available-packages.ts:57`,
   `:271-277`). A host that does not see the path reports the store tracks
   alone. The tool description text changes unconditionally
   (`spike:harness/src/tools/sandbox/list-available-packages.ts:228`). The new
   `imagePackagesFile` field threads through the conversation agent, the
   planner seed, and the data profiler
   (`spike:harness/src/config/environment-stores.ts:47-58`,
   `spike:harness/src/agents/conversation-agent.ts:279`,
   `spike:harness/src/tools/research/generate-plan.ts:1015-1018`,
   `spike:harness/src/tasks/data-profile.ts:365`).
10. **The briefing withholds `packages`.** The field joins the non-task list,
    thus a step agent never reads it
    (`spike:harness/src/prompts/briefing.ts:59-63`, `:72`). Inert without
    packages in the plan.
11. **A new `SandboxError` variant.** `farm_unavailable` joins the union
    (`spike:harness/src/sandbox/sandbox-error.ts:80`, `:144`). A consumer with
    an exhaustive switch sees a new case.
12. **New barrel exports** for the seam types — additive
    (`spike:harness/src/index.ts:401-409`).
13. **Merge caution, main drift**: the spike `k8s-client.ts` predates the
    owner annotation, the pod attribution labels, `isAliveById`, and
    `writableTail`/`podLabels` on `CreateSandboxMeta`
    (`harness/src/sandbox/k8s-client.ts`, `harness/src/sandbox/types.ts:245-249`).
    A merge must keep those main behaviors.
14. **Spec-level managed risk**: the managed-mount tarballs read a subtree out
    of a published variant image today, and the retirement of the variants
    removes that source. The replacement is an open decision, recorded as
    `BLOCKED`
    (`spike:harness/openspec/changes/preserve-farm-tracks-and-single-runtime-image/proposal.md`,
    "Impact").

## 5. The concurrency model

### Main today

One `current` pointer at the store root selects one package set for every
analysis (`harness/src/sandbox/docker-client.ts:126-135`,
`harness/openspec/specs/lib-store/spec.md:6-8`). Concurrent analyses run in
parallel workspaces and parallel step sandboxes, one sandbox per step
(`harness/src/sandbox/create-sandbox.ts:224-228`). But they share the one
active library set. A `current` flip between two `createSandbox` calls changes
what the next sandbox mounts
(`harness/src/sandbox/docker-client.ts:283-292`).

### Spike HEAD

The unit is **one farm per analysis**. Not per run, and not per step.

- The provider keys on the analysis id alone
  (`spike:harness/src/sandbox/types.ts:246`).
- The `per-analysis` kind exists so "two analyses hold two versions of one
  package at the same time" (`spike:harness/src/sandbox/types.ts:258-260`).
- The link pass treats the farm as "one tree for the whole analysis"
  (`spike:harness/src/tools/execute-analysis.ts:170-172`).
- `link_packages` extends the farm of `deps.step.analysisId`
  (`spike:harness/src/agents/sandbox/shared.ts:333`).
- Each `createSandbox` resolves the farm again, thus each step sandbox of one
  analysis mounts whatever the provider names at that instant
  (`spike:harness/src/sandbox/docker-client.ts:294-299`).
- A `fixed` source serves one farm to every analysis, the managed shape
  (`spike:harness/src/sandbox/types.ts:253-256`,
  `spike:harness/src/sandbox/k8s-client.ts:106-109`).
- The harness holds no lock. The locks live in the provisioner spec: parallel
  acquisition runs, a short mutex over the shared-metadata commit, and an
  exclusive reclaim
  (`spike:harness/openspec/changes/per-analysis-farm-mount/specs/lib-store-provisioner/spec.md:31`,
  proposal "What Changes").
- A farm link reaches the live sandbox of its analysis at once, with no
  restart (`spike:harness/src/tools/sandbox/link-packages.ts:43`, `:113`).
- The cache change accepts a racing-save loss between two sandboxes of one
  analysis
  (`spike:harness/openspec/changes/per-analysis-cache-mount/proposal.md`,
  "What Changes").

## 6. Specs

### Main today

Two lib-store specs exist: `harness/openspec/specs/lib-store/spec.md` and
`harness/openspec/specs/lib-store-build/spec.md`. There is no
`lib-store-provisioner` spec. The build spec requires three layered images
(`sandbox-base` → `sandbox-python` → `sandbox-python-r`), per-layer installs
into `/mnt/libs/current`, downstream `FROM` extension, and managed tarballs
extracted from the published images
(`harness/openspec/specs/lib-store-build/spec.md:82-186`).

### Spike HEAD — updated main specs

- `spike:harness/openspec/specs/lib-store/spec.md` — the store carries
  packages only, in the two farm tracks (Python and R). The image owns each
  interpreter, the conda prefix, and the Node packages (`:45-67`). The
  inventory merges the farm tracks with a baked image fragment (`:57-62`). The
  resolver env names the image paths `/opt/conda/bin` and
  `/opt/node/node_modules` (`:142-166`). Installation is host-mediated, takes
  effect for later sandboxes, and a running sandbox does not observe a store
  change (`:168-195`).
- `spike:harness/openspec/specs/lib-store-build/spec.md` — the build publishes
  one runtime image, `sandbox-base`, with no R and no Python library
  (`:109-141`). The conda prefix is built in place at `/opt/conda` (`:127-136`).
  The build also emits a content-addressed store and pushes it to GHCR as an
  OCI artifact with immutable version tags (`:360-406`). Cache preparation is
  verified to take effect at run time (`:408-470`).
- `spike:harness/openspec/specs/lib-store-provisioner/spec.md` — **new**. A
  separate network-enabled container builds the store and the farms, and it
  mounts no user data (`:13-28`). Each distribution stores once,
  content-addressed, with atomic publication (`:45-68`). Farms are symlink
  trees with per-analysis isolation and atomic swap (`:85-129`). Caches
  prepare into relocatable directories with a recorded workload (`:131-196`).
  R packages store and farm like Python (`:198-247`). A run preserves the
  tracks it does not rebuild (`:313-343`). The active pointer never swings
  under a live sandbox (`:272-286`).

### Spike HEAD — open change directories

- `agent-requested-packages` — adds the farm-extension seam and the
  `link_packages` tool to the always-on substrate
  (`specs/harness-sandbox-agents/spec.md`). Adds the planner requirement that
  each step names its packages in requirement form, with `validate_plan`
  refusal of locations (`specs/planning-enhancements/spec.md`). Drops the
  stale claim that a store change reaches only a later sandbox
  (`proposal.md`, "Why"). Extends the cache and entrypoint checks
  (`specs/lib-store-build/spec.md`, `specs/lib-store-provisioner/spec.md`).
- `per-analysis-farm-mount` — the store contract drops the `current` symlink.
  The farm becomes a per-sandbox mount at `/mnt/libs/current` from a provider
  seam (`specs/lib-store/spec.md`). The Docker gate validates the named farm
  and never the store pointer (`specs/docker-sandbox-provider/spec.md`). The
  provisioner drops `flip_current`, runs acquisitions in parallel under a
  metadata mutex, and publishes `deps.json`
  (`specs/lib-store-provisioner/spec.md:5-90`).
- `per-analysis-cache-mount` — a read-write per-analysis cache mounts at
  `/mnt/libs/cache`. A missing cache degrades the run and does not refuse it.
  A cache is per analysis, because a loaded cache entry executes machine code
  (`specs/lib-store/spec.md`). The build validation reads the mounted shape
  (`specs/lib-store-build/spec.md`).
- `preserve-farm-tracks-and-single-runtime-image` — a provisioning run
  preserves the tracks it does not rebuild. The build publishes one image.
  The delta removes two requirements (the per-layer install path, and the
  `FROM` extension) and renames one to "one sandbox runtime image"
  (`proposal.md`, `specs/lib-store-build/spec.md:236-263`).
- Two changes are archived in the spike:
  `archive/2026-08-06-content-addressed-lib-store` and
  `archive/2026-08-13-restore-warm-cache-and-name-farm-source`.

### Sync state inside the spike

The code already implements the farm mount and `link_packages`, but the main
spec tree does not state them yet. The spike main `lib-store` spec still
describes `current` as the active-version pointer
(`spike:harness/openspec/specs/lib-store/spec.md:8`, `:69-75`), while the code
never resolves a store-root `current`
(`spike:harness/src/sandbox/docker-client.ts:136-138`).

The same spec keeps the "only for sandboxes created after it" claim and the
"running sandbox is unchanged" scenario
(`spike:harness/openspec/specs/lib-store/spec.md:170`, `:191-195`). But
`link_packages` states that a link is live in the running sandbox
(`spike:harness/src/tools/sandbox/link-packages.ts:113`). The
`agent-requested-packages` proposal names this contradiction itself
(`spike:harness/openspec/changes/agent-requested-packages/proposal.md`, "Why").
The pending deltas in `per-analysis-farm-mount` and `agent-requested-packages`
carry the corrections.

## 7. Agent-facing content

### Main today

- The orient-core section is "Environment — No Network, No Installs". It says
  that packages were staged before the start, and "that is the whole of what
  exists" (`harness/src/prompts/sandbox-standards.ts:94-134`).
- The `list_available_packages` description says "No packages can be installed
  at runtime — only what this tool reports is importable"
  (`harness/src/tools/sandbox/list-available-packages.ts:211`). The
  unavailable note says "Nothing can be installed at runtime"
  (`harness/src/tools/sandbox/list-available-packages.ts:59-64`).
- The planner reads the "Available Packages" prose: confirm imports before you
  commit a step, prefer what is present
  (`harness/src/prompts/planner.ts:111-122`).
- The briefing renders no package data
  (`harness/src/prompts/briefing.ts:60-76`).

### Spike HEAD

- The orient-core section becomes "No Network, No Runtime Installs". It says
  "You cannot install a package yourself — acquiring one is a host action",
  and it tells the agent to report a missing package
  (`spike:harness/src/prompts/sandbox-standards.ts:99-108`).
- A third static layer, `sandboxPackageLinkPrompt`, appends only when the seam
  is bound (`spike:harness/src/prompts/sandbox-standards.ts:421-439`,
  `spike:harness/src/agents/sandbox/shared.ts:309-313`). It teaches: use
  `link_packages` after a failed import, pass the module name verbatim, a
  refusal is a real answer, and a version collision is terminal.
- The `link_packages` description states that the tool "links what the host
  staged" and that "it never installs, downloads, or acquires anything". It
  names the four outcome states, and it says that the link is live with no
  restart (`spike:harness/src/tools/sandbox/link-packages.ts:108-116`).
- The `list_available_packages` description changes to "The sandbox cannot
  install a package itself (no network, read-only store) ... report a missing
  package rather than trying to install it"
  (`spike:harness/src/tools/sandbox/list-available-packages.ts:228`,
  `:75-80`).
- The planner gains "The Packages of Each Step": name each package as a
  requirement, never a path or a URL, and the set is not a promise of
  completeness (`spike:harness/src/prompts/planner.ts:124-136`). A matched
  anti-pattern line appends (`spike:harness/src/prompts/planner.ts:276`).
- The briefing withholds the `packages` field from the rendered task, by
  design (`spike:harness/src/prompts/briefing.ts:59-63`, `:72`).
- No agent-facing text uses the word "farm". The prompts and the tool
  descriptions say "the library store" and "this sandbox's environment"
  (`spike:harness/src/prompts/sandbox-standards.ts:421-439`,
  `spike:harness/src/tools/sandbox/link-packages.ts:109`). The farm term stays
  host-side.
