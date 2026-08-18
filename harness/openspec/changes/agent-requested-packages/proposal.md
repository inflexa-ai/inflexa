# Agent-Requested Packages

## Why

A farm that carries only what one analysis wants is the goal of the per-analysis
work. But a step that meets an `ImportError` has no way to ask for a package.
Thus a narrow farm turns one package that the planner did not name into a failed
run, and the pool already holds that package.

Two defects sit beside that one. A distribution that a run acquires after the
catalog build gets no prepared cache. Thus its compiled kernels build again at
each first call, on each machine. And no check starts the entrypoint that a real
sandbox runs. Thus nothing proves that a prepared cache reaches a composed farm,
where the cache directories are links.

One requirement is already stale. `lib-store` states that a change to the package
set takes effect "only for sandboxes created after it", and that a running
sandbox does not observe a store change. A farm bind reflects a new link at once,
and the companion CLI change specifies exactly that. The two disagree today.

## What Changes

- The harness declares a **farm-extension seam**: an analysis id and a set of
  requests in, one outcome for each request out. A request names a distribution
  or an import name, because the evidence that a step holds is an `ImportError`
  and `sklearn` is not `scikit-learn`.
- Each sandbox agent gains a **tool over that seam**. The tool exists only when
  the embedder binds the seam, in the shape that `report_blocker` already uses:
  an optional dependency yields the tool.
- The tool **links from the pool and acquires nothing**. It starts no container,
  it opens no network connection, and it asks the user for nothing. A package
  that the pool does not hold is a refusal that names its reason. An R package
  carries its own reason, because this store cannot acquire one.
- **BREAKING** — `lib-store` loses the claim that a store change reaches only a
  later sandbox. An extension of the farm of an analysis reaches the live
  sandbox of that analysis, and the next import resolves it. The refusal that
  stays is the one that was always true: a step installs nothing itself.
- An **acquisition prepares no cache**. A numba entry keys on the type signature
  of a call, and an import supplies none. Thus a package that nobody wrote a
  workload for has nothing to run. Only the farm that holds the shared cache home
  can be prepared, and a run against another farm refuses.
- The **dependency graph records a version ordering**. The emitter runs where
  `packaging` and R already are, thus it records the store directories of one
  canonical name newest-first. A caller that names no version takes the head. A
  pre-release is not the head unless a farm already links one.
- The **planner names the packages of each step**, in requirement form. The
  embedder links what the pool holds, and it asks the user to install what the
  pool lacks. The set is not a promise of completeness: a step links what the
  plan missed, through `link_packages`.
- The **effectiveness check starts the real entrypoint** against a composed farm,
  where `numba-cache` and `matplotlib_config` are links into the catalog. The
  check of today overrides the entrypoint and copies the caches itself, thus
  `seed_caches` runs in no check at all.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `lib-store`: the farm-extension seam joins the mount contract. The
  host-mediated requirement drops the claim about a later sandbox, and it keeps
  the refusal of an in-sandbox install.
- `harness-sandbox-agents`: the request tool joins the resolved tool surface, as
  an optional dependency that yields it.
- `lib-store-provisioner`: an acquisition run prepares the caches of what it
  acquired, into the shared cache home. The graph records the version ordering of
  each canonical name.
- `lib-store-build`: the effectiveness check starts the entrypoint of the image
  and reads a composed farm, thus it proves the arrangement that an analysis
  uses.
- `planning-enhancements`: the planner names the packages of each step, and
  `validate_plan` refuses an entry that is not a requirement.

## Impact

- `harness/src/sandbox/types.ts` — the farm-extension seam beside `FarmSource`.
- `harness/src/agents/sandbox/shared.ts`, `types.ts` — the optional dependency
  and the tool name in the closed allowlist.
- `harness/src/tools/sandbox/` — the tool.
- `images/sandbox-provisioner/provision.py` — the preparation of an acquisition
  run, and the cache that follows a store directory.
- `images/sandbox-provisioner/emit_deps.py` — the version ordering.
- `images/sandbox-base/sandbox-entrypoint.sh` — the seed of more than one cache
  source.
- `.github/workflows/lib-store-provisioner.yml`,
  `scripts/lib-store-cache-check.py` — the check through the entrypoint.
- The CLI binds the seam, composes the farm, and gives `store link`. That work is
  the companion change `narrow-farms-and-package-link` in `cli/openspec/changes/`.
