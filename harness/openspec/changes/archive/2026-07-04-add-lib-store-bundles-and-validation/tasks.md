## 1. Gate 1 — per-track load test + honest packages.txt

- [x] 1.1 Add a uniform build-time load test per track: `import` (Python), `library()` (R, all of cran/bioc/github), `require()` (Node), `--version`/canned call (conda tools). Replace the existing uneven checks (CRAN `ls|wc`, GitHub log-grep).
- [x] 1.2 Make it **fail loud** — a load failure fails that track's stage (keep per-track `continue-on-error` at the workflow level for partial builds).
- [x] 1.3 Generate each track's `packages.txt` fragment from the *loaded* set, not the manifest. Parametrize the Dockerfile `packages-txt` stage per track.

## 2. Per-track tarballs

- [x] 2.1 Split the build so each track emits its own `<track>.tar.zst` containing its subtree + its `packages.txt` fragment (workflow + `build-libs-local.sh`).
- [x] 2.2 Local script: assemble a chosen bundle by extracting the selected track tarballs and concatenating their `packages.txt` fragments into `/mnt/libs/current/packages.txt`; add a `--bundle python-conda|python-r-conda` selector.
- [x] 2.3 Confirm `R_LIBS_SITE`/`.libPaths` still resolve when only a subset of R subtrees is present (core has none — harmless).

## 3. Arch matrix

- [x] 3.1 amd64 job (self-hosted 64GB): build all six tracks; emit full (6) + core (the 3 non-R) tarballs.
- [x] 3.2 arm64 job: build `python`/`conda`/`node` only; confirm it fits a free hosted arm64 runner's disk. Verify the arm64 `packages.txt` correctly omits arm64-stripped packages (e.g. liana `[extras]`).

## 4. Immutable publish + manifest

- [x] 4.1 Publish to write-once `<version>/linux-<arch>/<track>.tar.zst`; never rewrite a version.
- [x] 4.2 Emit a per-bundle-per-arch manifest pinning each track's tarball + sha256 (the lockfile).
- [x] 4.3 Move `latest/<bundle>/<arch>` promotion out of the build workflow — build writes a candidate manifest only, does **not** touch `latest`.

## 5. CLI pull handler (cli subsystem — separate cli/openspec change)

- [x] 5.1 `inflexa libs pull <bundle>`: resolve the bundle manifest, dedup-pull tracks by digest, extract, concat `packages.txt`, install under the lib-store dir (`~/.local/share/inflexa/libs`).
- [x] 5.2 Wire the interactive setup flow (arch + bundle Q&A → provisioning spinner) to reuse the same handler.

## 6. Gate 2 — after-build validator

- [x] 6.1 New `.github/workflows/validate-lib-store.yml`, triggered on build completion (`workflow_run`), amd64 + free arm64 jobs.
- [x] 6.2 On a fresh runner: invoke the real `inflexa libs pull` handler against the candidate version; mount the store in `sandbox-base`.
- [x] 6.3 Run the suite (section 7); on green, promote the candidate manifest to `latest/<bundle>/<arch>`; on red, leave `latest` and fail the run. Standard GitHub Actions status badge in the README (no S3 status JSON).

## 7. Validation suite

- [x] 7.1 Import/library/require **every** package listed in the mounted `packages.txt` (auto-derived from the file, not a hardcoded list — retires the current hardcoded `smoke-test-libs.sh` list).
- [x] 7.2 Curated real-op for the ~6–10 compiled anchors (DESeq2, scran, scanpy/numba, samtools, a spatial + a proteomics anchor). Model these as a small registry with `{pkg, track, arches}` metadata.
- [x] 7.3 R examples pass via `tools::testInstalledPackage`, with a network/`\donttest` denylist (AnnotationHub/biomaRt/org.*.eg.db etc.). Scope its runtime; keep it inside Gate 2.
- [x] 7.4 Assert `packages.txt` == actually-loadable on the mounted store (the invariant); fail loud on mismatch.

## 8. Spec + docs

- [x] 8.1 Sync the `lib-store-build` capability into `harness/openspec/specs/` on archive.
- [x] 8.2 Update `images/lib-store-builder/README.md` (bundles, arches, the two gates) and the lib-store CLI setup docs.
- [x] 8.3 Record the deferred items (arm64 R; per-track versioning; nightly re-validate) where a future reader will find them.
