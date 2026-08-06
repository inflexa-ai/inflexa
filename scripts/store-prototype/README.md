# Two-container package store — local prototype

A runnable prototype of splitting the sandbox in two: a **provisioner** that has
network and compilers and never touches user data, and the **sandbox**, unchanged,
which never has network and only ever reads what the provisioner produced.

Nothing here is wired into `cli` or `harness`. It is a standalone rig for deciding
whether the design holds before any of it becomes product code.

## Why it needs no harness changes to test

The harness already has the mount seam this design needs. `createDockerSandboxOps`
binds a host `libStorePath` read-only at `/mnt/libs`
(`harness/src/sandbox/docker-client.ts:314`), gated by `libStoreUsable`
(`docker-client.ts:126`), which requires only that `current/` resolve to a directory
holding `packages.txt` and `meta.json`. The CLI never passes `libStorePath` today —
it bakes the store into the image instead — but the code path is live.

So the content store and the per-analysis farms both live *under* that one bind:

```
~/.local/share/inflexa/libstore/          -> /mnt/libs        (ro in sandbox, rw in provisioner)
  store/<name>-<version>-<hash16>/        -> /mnt/libs/store/…   content-addressed, write-once
  farms/<analysis>/                       symlink farm: one analysis's closure
  current -> farms/<analysis>             the pointer libStoreUsable resolves
```

Farm symlinks target `/mnt/libs/store/…`, a path that exists inside both containers,
so a link written by the provisioner resolves in the sandbox.

The farm's interior is the layout the images already bake (`python/site-packages`,
`conda`, `r/*`, `node/node_modules`), so `.pth`, `R_LIBS_SITE` and `NODE_PATH` need
no change. `sandbox-base` ships the `.pth` already and it is inert only because the
directory does not exist — mounting a farm there activates it.

> Note the store path is `libstore`, **not** `~/.local/share/inflexa/libs`. That one
> is already the CLI's per-image `packages.txt` inventory cache
> (`cli/src/lib/env.ts` → `libsDir`, whose own comment says it is "NOT a library
> store").

## Running it

Requires a running Docker or Podman daemon. Pick the engine with `CTR=podman`.

```sh
./inflexa-store build                              # provisioner image (~5 min, once)
./inflexa-store add demo scanpy                    # NETWORK ON, ~5 min cold
./inflexa-store test                               # the acceptance suite
./inflexa-store run 'python3 -c "import scanpy"'   # NO NETWORK
./inflexa-store shell                              # poke around
./inflexa-store du                                 # disk accounting
```

Cache warm-up takes a workload, because numba compiles at first *call*:

```sh
WARM=numba,matplotlib,scanpy WARM_SCRIPT=/mnt/libs/warm/sc_workload.py \
  ./inflexa-store add sc scanpy igraph
```

`add` is incremental — re-running it with extra specs re-resolves the whole closure,
installs only what is genuinely new, and rebuilds the farm.

## What the acceptance suite proves

15/15 pass on `linux/arm64` against `ghcr.io/inflexa-ai/sandbox-base:latest` with a
50-distribution scanpy closure. The checks that were actually in doubt:

| Check | Result |
|-|-|
| Compiled C extensions load through symlinks | numpy 2.4.6, correct results |
| Vendored shared libs resolve via `$ORIGIN` | `scipy.linalg.det` correct — links are per top-level entry, so `scipy/` and `scipy.libs/` come from one store dir and `$ORIGIN/../scipy.libs` stays inside it |
| `importlib.metadata` resolves versions | `.dist-info` symlinks are seen by the metadata finder |
| Namespace-package collisions | 0 collisions across 50 dists; the farm builder promotes a shared prefix to a real directory and merges both sides |
| Sandbox has no egress | TCP to 1.1.1.1 refused, `--network none` |
| Store and farm are read-only, uid 1000, all caps dropped | enforced |
| Dedup | second scanpy analysis costs **8 MB**, 50 of 51 dists reused |

## Findings that change the design

**1. numba's in-tree cache is unusable on a read-only store — and already is today.**
numba picks a cache locator by trying to *write* to it, so on a read-only store the
in-tree locator is skipped for reads as well as writes and everything recompiles.
Measured on the current baked `sandbox-python` image: it ships 25 warmed in-tree
`.nbi` files and still recompiled 24 entries into `$HOME` at runtime. This is not a
regression the store design introduces — it is pre-existing, and the fix is the same
either way: warm into a `NUMBA_CACHE_DIR` under the store, and copy it to a writable
path before use. Read-only `NUMBA_CACHE_DIR` does not work either (30 saves, 0 loads);
seeded-writable does (29 loads, 0 recompiles).

**2. Warming by importing does nothing.** numba compiles at first call. Importing
`numba`, `matplotlib` and `scanpy` produced **0** cache entries; running a real
scanpy workload produced 23. The current image's warm-up step is import-only.

**3. The warm-up must run through `/mnt/libs/current`, not the farm's own path.**
numba's cache key includes the source file path. Warming via
`/mnt/libs/farms/sc/…` yielded 0 loads and 29 recompiles in the sandbox; warming via
`current` yielded 29 loads and 0. Same family of mistake as pointing symlinks at a
host path. The provisioner therefore flips `current` *before* warming.

**4. numba caches are per type signature.** A warm-up only covers the exact call
shapes it executed; anything else legitimately recompiles. Warm with a workload that
resembles the real analysis.

**5. Staging must happen inside the store.** Publishing is a rename, and a rename is
only atomic within one filesystem. Staging under `/tmp` fails with `EXDEV` across the
bind mount.

## Disk

| | Size |
|-|-|
| `sandbox-base` image | 2.34 GB |
| store, 51 distributions (scanpy + scipy closures) | 769 MB |
| a farm | 32 KB – 1.6 MB (symlinks, plus the warmed caches) |
| **total for a working scanpy sandbox** | **~3.1 GB** |
| baked `sandbox-python` today, for comparison | 11.4 GB |

## What is not covered yet

- **conda.** Deliberately not farmed: its binaries carry the build prefix compiled
  in. The farm creates an empty `conda/` as a mount point; the prefix would be
  bind-mounted whole at the exact path it was built for. Untested here.
- **R and Node tracks.** The farm layout has slots for them; only Python is
  provisioned. R is the harder case — `R_LIBS_SITE` already takes a search path, so a
  farm may not even be necessary there.
- **`PIP_TARGET`.** `sandbox-base` does not set it (verified), so the prototype is
  unaffected. `sandbox-python` sets it to a path that is read-only under this design,
  and would need a per-session override.
- **Concurrency.** One `current` pointer means one active farm per store. Concurrent
  sandboxes on different closures need either a per-sandbox `libStorePath` or a
  per-step mount.

## If this graduates

For the CLI to use a mounted store instead of a baked image:

1. Pass `libStorePath` in the `createSandbox` call at
   `cli/src/modules/harness/runtime.ts` (currently omitted on purpose).
2. Point the `packagesFile` dep at `<store>/current/packages.txt` instead of the
   OCI-label cache in `cli/src/modules/libs/packages.ts` — `list_available_packages`
   reads that path on the **host**, not in the container.
3. Seed the warmed caches. There is no per-session prologue seam today; the natural
   home is `images/sandbox-base/sandbox-entrypoint.sh`, which already runs before the
   workload.
4. Revisit two pieces of agent-facing copy that this makes false: the `packages.txt`
   header ("Do NOT attempt to install packages") and
   `harness/src/prompts/sandbox-standards.ts` → "No Network, No Installs". The
   sandbox still has no network; installing becomes a host-mediated action.
