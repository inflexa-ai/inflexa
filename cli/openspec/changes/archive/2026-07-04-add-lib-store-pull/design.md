# Design

## Context

The library store carries every R/Python/Node/conda analysis package, mounted read-only into each sandbox at `/mnt/libs/current`. Two facts, discovered by grounding this change in the code, shape the whole design:

1. **The mount already works.** `harness/src/sandbox/create-sandbox.ts:62` accepts an optional `libStorePath`; `docker-client.ts:118` bind-mounts `${libStorePath}:/mnt/libs:ro`; `mount-plan.ts:69` sets the resolver env (`R_LIBS_SITE=…/r/github:…/r/bioconductor:…/r/cran`, `NODE_PATH`, conda on `PATH`, no `PYTHONPATH` — `.pth`) **only when `stores.libs === true`**. The CLI just never sets `libStorePath`. So this change adds *no harness code* — it produces the host directory and points the config at it.
2. **A missing store is degraded, not broken.** `list-available-packages.ts:26` returns `{available:false, content:"…may not be mounted…"}` without throwing. So provisioning is an *offer*, and lazy detection never has to block a launch.

The build change owns producer semantics (per-track content-addressed immutable tarballs, per-bundle-per-arch manifests, validated `latest`). This change owns the **consumer**: resolve → dedup-pull → verify → assemble → atomically activate.

## The on-disk store

```
 ~/.local/share/inflexa/libs/          ← libStorePath  (bind-mounted → /mnt/libs:ro)
 ├── current -> 2026.07.04-a1b2c3        ← the ONE mutable pointer (a symlink)
 ├── 2026.07.04-a1b2c3/                  ← a version: immutable once activated
 │   ├── r/{cran,bioconductor,github}/     (present only for the full bundle)
 │   ├── python/   node/node_modules/   conda/bin/
 │   └── packages.txt                      ← concat of the pulled tracks' fragments
 ├── .staging-<version>/                 ← in-flight extract; renamed in on success
 └── <track cache>                       ← dedup substrate (see "Dedup mechanism")
```

The **entire parent** is mounted, so `current`→`<version>` resolves *inside* the container (both the symlink and its target are under the mount). The resolver env points at fixed `/mnt/libs/current/r/...` paths, so activation is purely "make `current` point at a complete version." Mirrors `mount-plan.ts:69`'s hard-coded subpaths — the layout is a contract, not a convention.

## Atomic activation — the correctness spine

```
 download → .part → verify sha256 → extract → .staging-<version>/ → assemble packages.txt
                                                        │
                                          (cheap local sanity: non-empty, subtrees present)
                                                        │
                              rename .staging-<version> → <version>/   (same fs, atomic)
                                                        │
                              symlink swap: current → <version>        (atomic on POSIX)
```

`current` is never partial. A sandbox that starts at any instant sees a complete old version or a complete new one. This is the embedding downloader's `.part`→rename discipline (`embedding/setup.ts:97`) lifted from one file to a whole tree, plus a final symlink flip. The symlink swap is `rename()` of a temp symlink over `current` — atomic on POSIX; no window where `current` is missing.

## The pull algorithm

```
 inflexa libs pull [bundle] [--core|--full] [--version V] [--yes]
   1 arch      uname -m → linux-amd64 | linux-arm64                 (NEVER ask)
   2 bundle    default: full@amd64, core@arm64; --core/--full override
               arm64 + full  → explain (no R tarballs on arm64), fall back to core
   3 manifest  GET <base>/{latest/<bundle>/<arch> | <V>/…}/manifest.json
               → pins each track: { url, sha256, size }
   4 plan      which track digests are already on disk? → download = Σ(missing sizes)
   5 confirm   show total size; skipped when --yes or non-interactive
   6 fetch     missing tracks in PARALLEL → <name>.part → verify sha256 → keep
   7 extract   each track into .staging-<version>/<subtree>
   8 assemble  concat pulled tracks' packages.txt fragments → .staging-<version>/packages.txt
   9 check     packages.txt non-empty; every expected subtree present  (cheap, local)
  10 activate  rename staging → <version>/ ; flip current → <version>   (ATOMIC)
  11 prune     keep last N versions; never delete the one `current` points at
```

Step 4 is the "just works" core: it tells the truth about download size *before* committing, and digest dedup makes an update tiny (unchanged R triple = 0 bytes on the wire).

## Bundles, arch, and the questions we DON'T ask

The build change defines `python-conda = {python,conda,node}` and `python-r-conda = {python,conda,node,cran,bioconductor,github}` with the R triple all-or-none. The CLI surfaces those as two user-facing choices and infers the rest:

```
              amd64                         arm64
 full   →  python-r-conda   ✓          (unavailable — no R tarballs) → explain, offer core
 core   →  python-conda     ✓          python-conda  ✓
```

- **Arch: never a question.** `uname -m`. arm64 collapses the choice to "core, and here's why R isn't here yet."
- **Bundle: one question at setup, a default everywhere else.** Default `full` on amd64 (it *is* the bioinformatics product); `--core` opts down. So `inflexa libs pull` with no args does the right thing on a bare machine.

## Three entry points, one handler

```
 ┌ setup wizard (infra/setup.ts) ┐
 │ select() need-R? → spinner()  │─┐
 └───────────────────────────────┘ │
 ┌ lazy (before sandbox launch) ─┐ │   ┌─────────────────────────────┐
 │ current missing? → one-line   │─┼─▶ │  libsPull(bundle, opts)      │
 │ OFFER (never blocks)          │ │   │  (the single dogfooded path) │
 └───────────────────────────────┘ │   └─────────────────────────────┘
 ┌ explicit ─────────────────────┐ │        ▲
 │ inflexa libs pull [--version] │─┘        │
 └───────────────────────────────┘   Gate 2 validator calls the SAME handler
                                      with --version <candidate>, pre-promotion
```

Decision #1 from the build change (validator uses the real handler) is why `--version` exists and why the setup spinner wraps `libsPull` rather than a bespoke provisioner: one path, dogfooded by CI on every build.

## The coupling guard (a real footgun)

Docker auto-creates a **missing** bind-mount source as a **root-owned empty directory**. If `modules/harness/config.ts` set `libStorePath` unconditionally, a machine that never ran `libs pull` would mount an empty root-owned `/mnt/libs`, and `list_available_packages` would still say `available:false` — but now with a stray root-owned dir on the host. So:

```
 harness config builder:
   libStorePath = exists(join(libRoot,"current")) ? libRoot : undefined
```

Set the knob **iff `current` exists**. This is the clean seam between the two subsystems: `libs pull` creates `current` → the harness config starts mounting it. No store, no mount, no footgun.

## Dedup mechanism (open — not UX-facing)

Both options satisfy resumable + dedup + atomic; the choice is disk vs bandwidth:

```
 A  content-addressed blob cache      keep <track>.tar.zst by sha256; extract into version dirs
    + future pulls fully resumable    − ~1.5× disk (tarball + extracted)
    + re-extract without re-download

 B  reflink/hardlink between versions  extract fresh; unchanged track subtree links to prior version
    + near-zero extra disk             − re-extract needs the tarball again (re-download)
    + reflink (btrfs/xfs) = free copy   − hardlink correctness under read-only mount needs care
```

Recommendation: **A** for v1 (predictable, fs-agnostic, matches the manifest's content-addressing), prune blobs on a `--reclaim` later. Revisit if disk pressure bites.

## Published-store base URL

The handler needs a base URL for the S3-published tree. Bake a default (`INFLEXA_LIB_STORE_URL` env → config → compiled default pointing at the public bucket/CDN). For OSS "just works," the bucket must be **public-read** so pull needs no credentials. The build change publishes under `<version>/linux-<arch>/<track>.tar.zst` + `latest/<bundle>/<arch>/manifest.json`; this handler is the reader of exactly that layout.

## `libs status` — legibility

```
 inflexa libs status
   Store   ~/.local/share/inflexa/libs
   Active  python-r-conda @ 2026.07.04-a1b2c3   (linux-amd64)
   Tracks  cran ✓  bioconductor ✓  github ✓  python ✓  conda ✓  node ✓
   Packages 1,247 advertised
   Up to date  (latest = 2026.07.04-a1b2c3)
```

Makes the whole thing inspectable: what's active, which arch/bundle, whether it's current. `libs list` prints the resolvable bundles for this arch.

## Open / deferred

- **arm64 `full`** — deferred upstream (r2u amd64-only; bioconda aarch64 patchy). Surfaced as a message, never an error; the bundle resolver simply has no `full` for arm64.
- **Dedup mechanism** — A vs B above; A recommended for v1.
- **Blob GC / disk budget** — `prune` keeps last N *versions*; a separate `--reclaim` for the blob cache is a later add.
- **Auth'd/private stores** — out of scope; OSS pull is anonymous against a public bucket.
