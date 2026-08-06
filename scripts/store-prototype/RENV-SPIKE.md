# Spike: renv + pak for the R track

This note records the Phase 1 spike. It uses Simplified Technical English. The
question was: can renv build the R track from a lock, on P3M binaries, and how
large is the system-library gap that r2u filled for free? Each result is
**[measured]** in a `rocker/r-ver:4.6.0` container, as root, on linux/arm64
(podman). The image is the one the manifest pins (`lib-store-manifest.yaml:8`).

## Verdict — GO

Use renv, with pak as the install engine. The one real risk — the system-library
gap — is not a manual burden. pak fills it automatically.

## Findings

1. **P3M serves binaries on arm64. [measured]** pak and renv installed as binary
   packages. In DEP's 160-package closure, 119 packages came as arm64 binaries and
   about 40 built from source. The source builds are the heavy Bioconductor
   packages, which compile from source under the current build too.

2. **pak resolves and installs the system-library gap by itself. [measured]** This
   is the key result. pak marks each system dependency present (✔) or missing (✖).
   Because it runs as root on Ubuntu, it then runs `apt-get` for the missing ones,
   before it builds. The exact command pak ran:

   ```
   apt-get -y install libx11-dev libcurl4-openssl-dev libssl-dev cmake libuv1-dev \
     perl zlib1g-dev libglpk-dev libxml2-dev pandoc libnetcdf-dev libpng-dev libicu-dev
   ```

   So we do not maintain a hand-written system-library list. pak reads each
   package's `SystemRequirements` and acts on it.

3. **The DEP git source works through pak. [measured]** pak installed DEP 1.32.0
   from `git::https://git.bioconductor.org/packages/DEP@251eef42…` and DEP loaded.
   The deprecation warning is expected; it is the reason we pin the commit. So the
   lock tooling handles the special git-bioconductor case natively. The
   hand-written `install_git` line is not needed.

4. **The lock pins the index snapshot. [measured]** The renv lock recorded the
   repository URL `https://p3m.dev/cran/2026-06-23` — a dated P3M snapshot. This is
   the reproducibility gain: the lock freezes the exact index state.

5. **The lock → restore roundtrip works. [measured]** `renv::snapshot(type = "all")`
   captured the full library. After a wipe, `renv::restore` reinstalled the
   packages and they loaded. (The first attempt used the default implicit snapshot,
   which scans project code; the empty project captured only renv. That was a test
   error, not a renv defect.)

## Timing [measured]

| Step | Time |
|-|-|
| pak system-requirements query (`pkg_sysreqs`) | 6 s |
| pak install RcppArmadillo (binary) + Biobase (source) | 7 s |
| DEP full closure — 156 deps, source Bioc included | 7 m 49 s |
| Restore roundtrip (data.table, from cache) | under 1 s |

The DEP time is dominated by two source compiles: mzR (4 m 15 s) and Rhdf5lib
(2 m 15 s). These compile from source under any tool, so they are not a renv cost.

## Caveats — be honest

- **Build-time libraries, not runtime.** pak installs `-dev` packages in the
  builder. The sandbox needs the runtime library, not the `-dev` one. The current
  build already provisions runtime libraries; that duty does not change. renv/pak
  solves the *build*-side gap, not the *runtime*-side one.
- **arm64 only.** amd64 today uses r2u. On amd64, pak would use P3M binaries and
  the same auto-`apt` path. P3M binary coverage on amd64 is wider than on arm64, so
  amd64 is expected to be at least as good. Not measured here.
- **root + Ubuntu required for the auto-`apt` step.** The builder and the
  Provisioner both run as root from the Ubuntu base, so this holds.

## Effect on the plan

- The §8 #7 decision (renv restore vs an r2u hybrid) resolves to **renv + pak**. The
  system-library gap does not force the hybrid.
- Phase 1 can now build the R track from a renv lock, and let pak fill the system
  libraries at build time.
