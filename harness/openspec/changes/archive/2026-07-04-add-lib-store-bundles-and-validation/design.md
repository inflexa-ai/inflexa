# Design

## Context

The library store carries all R/Python/Node/CLI analysis packages, mounted read-only into every sandbox at `/mnt/libs/current`. The `harness` `lib-store` spec covers only the **runtime mount contract**; how the store is *built and published* is explicitly out of scope there. This change owns that build+publish+validate pipeline. Its code lives at the repo root (`images/lib-store-builder/`, `scripts/`, `.github/`), but its **contract** is colocated with the runtime spec it feeds (decision A), because the load-bearing invariant — *every package `packages.txt` advertises is actually loadable* (advertised ⊆ loadable: the file must not LIE; extra loadable-but-unadvertised packages are tolerated, not flagged) — is a contract between the build and the harness runtime.

## Decisions

- **A — spec home:** colocate the `lib-store-build` capability under `harness/openspec/specs/`. Rejected: a standalone OpenSpec store (heaviest, only worth it if the builder splits into its own repo) and tests-only (loses the "must not lie" invariant as a reviewable requirement).
- **B — packaging unit ≠ selection unit:** ship per-track content-addressed tarballs; a bundle is a client-side selection of tracks.
- **C — fail loud**, in **two** gates (build-time cheap, after-build extensive), each in a different environment.
- **1 — the validator uses the real CLI pull handler**; the setup flow reuses it.
- **2 — published versions are immutable**; `latest` is the only mutable pointer and advances only onto a validated version.
- **3 — standard GitHub Actions badge**, no S3 status JSON, no nightly (for now).

## B — packaging unit vs selection unit

The workflow and local script never build the Dockerfile's `final`/`export` stages — they build each *track* stage and extract it. So a bundle was already just "which tracks get assembled." We make that explicit and push it to download time:

```
 PACKAGING UNIT (stored/shipped)  → per TRACK   (parallel pull + untar, dedup)
 SELECTION UNIT (what a user asks) → per BUNDLE  (a named set of tracks)
```

```
 s3://…/<version>/linux-amd64/cran.tar.zst          (+ cran.packages.txt inside)
                              bioconductor.tar.zst
                              github.tar.zst
                              python.tar.zst
                              conda.tar.zst
                              node.tar.zst
        …/<version>/linux-arm64/python.tar.zst        ← no R tarballs on arm64
                              conda.tar.zst
                              node.tar.zst

 # tarballs are ARCH-scoped and SHARED across bundles; the manifest is the
 # per-BUNDLE lockfile and lives under its own <bundle>/ segment:
        …/<version>/<bundle>/linux-<arch>/manifest.json   ← immutable per-version lockfile
        …/latest/<bundle>/linux-<arch>/manifest.json      ← the one mutable promoted pointer
```

**Manifest layout (as implemented).** The manifest is keyed by *bundle*, not arch,
so it sits under its own `<bundle>/` path segment — `<version>/<bundle>/linux-<arch>/manifest.json`,
promoted to `latest/<bundle>/linux-<arch>/manifest.json` — while the track tarballs
it pins stay at the arch root `<version>/linux-<arch>/<track>.tar.zst` (one physical
tarball serves every bundle that selects that track, straight out of decision B).
This supersedes an earlier sketch that colocated a `<bundle>.manifest.json` beside the
tarballs under `<version>/linux-<arch>/`: two bundles share the same tarballs but pin
different track *sets*, so the manifest belongs on a bundle path, not the shared arch
path. The CLI resolver (`cli/src/modules/libs/manifest.ts` `manifestUrl`) and the
publish workflow (`.github/workflows/lib-store.yml`) are the source of truth for these
paths; the per-bundle manifest directory (`<bundle>/`) also cleanly separates the
mutable `latest` pointer from the immutable tarball tree.

The R triple is **not independently selectable** — cran/bioc/github share one `.libPaths()` (`R_LIBS_SITE = github:bioc:cran`) and form a dependency chain (a github pkg imports a bioc pkg imports a cran pkg). So per-track *tarballs* are fine for transfer, but a valid *selection* travels the R triple as a unit:

```
 python-conda    = { python, conda, node }
 python-r-conda  = { python, conda, node, cran, bioconductor, github }
                                          └────── R triple, all-or-none ──────┘
```

Why per-arch `packages.txt` must be **derived, not templated**: `core-amd64 ≠ core-arm64` as a set — `liana[extras]` is stripped on arm64 (pyscipopt/SCIP has no arm64 build), and bioconda aarch64 coverage is patchy. A manifest-templated `packages.txt` would lie on arm64. This single fact is the whole argument for the validation work.

The build collapses to one heavy job plus one light job:

```
 job 1  self-hosted 64GB (amd64)        job 2  free arm64 hosted runner
 ├ build cran→bioc→github               ├ build python
 ├ build python                         ├ build conda
 ├ build conda                          ├ build node
 ├ build node                           └ emit 3 track tarballs (core)
 └ emit 6 track tarballs                    (no R compile → fits a hosted runner)
     (full = all 6; core = the 3 non-R
      tarballs are a free byproduct)
```

Only the R compile needs the big runner. Confirm the core store size fits the ~14 GB hosted-runner disk.

## Immutability + manifest = content-addressed store

```
 immutable versions  +  per-track digests  =  content-addressed store
   • latest/<bundle>/<arch> pins {track → tar + sha256}  (the manifest IS the lockfile)
   • unchanged track across versions → same digest → client already has it → skip pull
     (dedup + blob-level resumable pull, straight out of immutability)
   • a version is NEVER rewritten; a bad build is abandoned, not patched
   • latest is the one mutable pointer; it only ever advances onto a GREEN version
```

v1 may treat a version as one coherent build (all tracks built together); the manifest leaves room to grow into per-track versioning (a python-only change bumping `python`'s digest without rebuilding R) later.

## C — two fail-loud gates, in different worlds

```
 GATE 1  build-time load (CHEAP)        in the builder: compilers, -dev headers, network,
                                        warm caches, writable FS. import/library each pkg.
                                        FAIL LOUD on gross load failure. Emits each track's
                                        packages.txt from the loadable set.

 GATE 2  after-build validator          FRESH machine — none of the above. read-only mount,
         (EXTENSIVE, "as a user")        no network, runtime env only, correct arch. pulls the
                                        published store via the real CLI handler, mounts in
                                        sandbox-base, runs the full suite. FAIL LOUD.
                                        GREEN → promote latest. RED → latest unchanged.
```

They catch different classes *because* they run in different environments. A package that loads in the builder only because a `-dev` lib or a writable cache is present passes Gate 1 and fails Gate 2 — exactly what a user would hit (the same reason numba's JIT cache is pre-warmed at build time: the runtime mount is read-only). Gate 1 gives fast, arch-native, cheap feedback and produces the honest `packages.txt`; Gate 2 proves it on the machine that matters and is what gates promotion.

```
 manifest change on main
        │
        ▼
 BUILD (permissive, write-once) ── Gate 1 ──▶ publish <version>/… (IMMUTABLE)
                                              write CANDIDATE manifest; does NOT move latest
        │ workflow_run: build ok, version=X
        ▼
 VALIDATE (separate action) ── Gate 2 (fresh machine, as a user) ──▶
        GREEN → promote candidate → latest/<bundle>/<arch>  + green badge
        RED   → red badge, latest UNCHANGED, human fixes manifest → rebuild
```

## D — why validation is layered (not "max scrutiny for everything")

The principle is **use the strongest check that can be *auto-generated* per ecosystem; add bespoke anchors only where nothing can be** — not import-vs-realop dogma. The ecosystems are asymmetric:

```
              strongest AUTO check            bespoke needed for "does real work"?
 R (CRAN/Bioc) run the pkg's OWN examples      no — upstream authored them
                (tools::testInstalledPackage)
 Python        import X                          yes — a fixture per package
 Node          require(X)                        yes
 conda tools   `tool --version` / trivial call   partial — 7 tools, canned invocations
```

Why not hand-write a real-op for all ~104 Python packages ("max scrutiny everywhere"):

1. **It doesn't generalize.** "A real operation" needs inputs shaped to *that* package (DESeq2 wants counts+colData+design; scanpy wants an AnnData of the right dims). There is no generic real op — max-scrutiny-for-all means authoring 100+ upstream integration tests.
2. **That is the we-don't-fix-R rabbit hole by another door.** Each bespoke test tracks a churning upstream API; an unrelated signature change reddens the gate. 100 of those is a second codebase whose job is chasing upstream — the exact scope-out.
3. **False positives erode the gate.** `import scanpy` failing is unambiguous (broken binding). A bespoke `scanpy.pp.pca(toy)` failing is ambiguous (pkg? fixture? API moved? edge case?). A gate that cries wolf gets ignored.
4. **Mostly redundant with import.** What escapes today is *load* failures (`.so`/binding/ABI) — those throw on import, and import-for-all already catches them. The extra class ("imports clean but the compiled backend computes garbage / segfaults") is real but rare and concentrated in compiled-heavy packages.

So the value of "real work" scrutiny concentrates in **compiled** backends, and its cost concentrates in **fiddly-API** packages — spend bespoke effort exactly on the ~6–10 compiled anchors, let import cover the pure-Python long tail (where "imported" ≈ "works", no compiled step to rot).

R is the exception because **you are not the author** — the package ships its own examples and R runs them (`tools::testInstalledPackage`, `example()`). That's near-maximum scrutiny, auto-discovered, zero bespoke fixtures. The one real cost is a **network/`\donttest` denylist**: AnnotationHub/biomaRt/org.*.eg.db examples hit the network, which the read-only no-network sandbox forbids. So the R example suite is a denylist-filtered pass, potentially heavier/slower than the per-package `library()` — a candidate to run inside Gate 2 but scoped, not a per-PR concern (nothing here is per-PR).

```
 EVERY package     import / library() / require()      (auto — the escaping-bug net)
 ~6–10 anchors     one tiny real op                    (bespoke — compiled backends)
 R packages        their own examples, network-filtered (auto — "not the author")
 7 conda tools     `--version` / canned invocation      (bounded)
 always            packages.txt == actually-loadable    (the invariant, FAIL LOUD)
```

## D′ — known-hard packages ⇄ anchors

The builder carries opaque, accreting workarounds (ANCOMBC from r-universe; DEP from a frozen Bioc 3.22 repo; MSstats' C++14 override; the `make -j` abort hazard). Each such package is precisely one that most deserves an anchor assertion — it is the most likely to silently re-break on the next Bioc bump. So the "known-hard registry" is not a separate artifact: it is metadata on the validation set (`{ pkg, source, track, validate: anchor, arches }`), which turns "why does this weird install line exist?" from a buried Dockerfile comment into a row a test reads. Legibility and coverage from one structure.

## Cross-subsystem dependency (#1)

"Validate as a user" presupposes a user download path. The CLI has none today (no `libStorePath` knob, no resolve-manifest→pull→extract→mount flow). Decision 1: build the real `inflexa libs pull <bundle>` handler first; the validator invokes it and the setup-flow spinner reuses it — one dogfooded code path. That handler is a `cli/` deliverable and lands as its own `cli/openspec` change; it is tracked here as a hard dependency of Gate 2.

## Open / deferred

- **Python+R+conda on arm64** — deferred (r2u amd64-only; bioconda aarch64 patchy). arm64 has no R tarballs.
- **Per-track versioning** — v1 = coherent per-version build; manifest reserves room to grow.
- **Nightly re-validate of `latest`** — not built now; immutable stores don't drift, but the sandbox-base image and the R network denylist do, so it's a future signal.
