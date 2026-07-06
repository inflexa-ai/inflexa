## Context

Acceptance (`.github/workflows/lib-store-acceptance.yml` → `scripts/lib-store-acceptance.sh`
→ `scripts/lib-store-validate/run.sh` → `validate.py`) is a **separate run** from
the builder (`.github/workflows/lib-store.yml`, which owns the load check and the
`lib-store-coverage.py` coverage table). Acceptance boots the just-published image
on a fresh machine and runs `validate.py` inside it. `validate.py` today has three
phases:

1. **import-all** — derived from the mounted `packages.txt`; `import`/`library()`
   for every advertised package; enforces advertised ⊆ loadable. The promotion gate.
2. **anchors** — a small curated real-op registry (`anchors.json` + `anchors/`),
   arch- and advertised-filtered.
3. **R-examples** — opt-in (`--r-examples` / `--full`), runs each R package's own
   examples via `tools::testInstalledPackage` with a network/`\donttest` denylist
   (`r_examples.R`).

The cherry-picked `lib-validator/` suite (~260 `<pkg>.R`/`<pkg>.py` + `run_all.py`)
is a purpose-built replacement for the *behavioral* coverage that phases 2 and 3
provide, at far greater breadth and across both languages, with no network/fixture
flakiness. This change swaps phases 2 and 3 for the new suite and leaves phase 1
(the gate) intact.

## Goals / Non-Goals

**Goals:**
- Make `lib-validator/run_all.py` the single behavioral pass of acceptance.
- Make acceptance **non-gating**: it validates the published store on a fresh
  machine and reports a per-arch results table + green/red status; it mutates
  nothing. The **build** owns `latest` (as it already does for the image tag).
- Keep the import-all invariant as part of what acceptance checks and reports.
- Relocate the suite to repo-root `scripts/lib-validator/` with history preserved.
- Delete the now-dead `r_examples.R`, `anchors.json`, and `anchors/`.
- Keep the coverage report *logic* (`lib-store-coverage.py`) unchanged.

**Non-Goals:**
- Rewriting the individual validator scripts (they are used as-is).
- Changing how acceptance obtains the store (still boot-the-image / mount-tarballs).
- Changing the build-time load check, coverage *computation*, pack, or `sandbox pull`.
- A manual promotion gate — `latest` advances automatically with each build; the
  human safety net is reviewing the acceptance badge, not a promote step.
- Scoping `run_all` to the advertised set — the per-script not-installed guard
  already makes an absent library a skip, so no manifest plumbing is required.

## Decisions

**D1 — Embed `run_all.py` as phase 2 of `validate.py`, not a second driver step.**
`validate.py` stays the single acceptance entrypoint and single summary. Its new
phase 2 shells out to `run_all.py` inside the image and gates on its exit code.
Rationale: one green/red verdict, one log; matches the user's "embed into something
else" steer. Alternative (a second `run.sh` docker invocation) splits the verdict
across two containers and duplicates the boot.

**D2 — Locate the validators via a mounted path, not relative to the suite dir.**
`run.sh` mounts `scripts/lib-validator/` read-only at `/opt/lib-validator`
(alongside the existing `/opt/lib-store-validate` suite mount) and exports
`LIB_VALIDATOR_DIR=/opt/lib-validator`. `validate.py` runs
`python3 $LIB_VALIDATOR_DIR/run_all.py` (default `/opt/lib-validator`). `run_all.py`
is already self-contained (`HERE = __file__.parent`, per-script `cwd=HERE`), so it
runs correctly from any mount point.

**D3 — Select `run_all --lang` by interpreter presence to avoid false NO_INTERP
failures.** `run_all.py` counts `NO_INTERP` (missing `Rscript`) as broken and exits
non-zero. On the **python-only** image there is no R runtime, so all `.R`
validators would be NO_INTERP and wrongly turn acceptance red. `validate.py`
therefore passes `--lang py` when `shutil.which("Rscript")` is absent, and
`--lang all` when present. Rationale: keeps `run_all`'s standalone contract intact
(a dev with no R still sees NO_INTERP flagged) while making acceptance's scoping
explicit at the call site. Alternative (weaken `run_all` so NO_INTERP never fails)
was rejected — it would let a broken/missing R runtime pass silently for a
standalone user; here the R track's presence is still enforced by import-all.

**D4 — Retire the anchors registry entirely, not just R-examples.** The per-library
validators subsume the "curated real operation for a compiled package" role that
anchors served, at ~260 libraries vs a handful. Keeping both would duplicate intent
and maintenance. import-all remains the only thing `run_all` cannot do (it skips
absent libraries), so it stays.

**D5 — Simplify the flag surface.** `--r-examples`, `--full`, and `--anchors/--no-anchors`
disappear from `validate.py`, `run.sh`, and `lib-store-acceptance.sh`; acceptance
runs import-all + the per-library suite by default. A `--no-validators` escape
hatch on `validate.py` (import-all only) replaces the old `--no-anchors` "fast core"
mode for quick local checks. The `LIB_STORE_R_EXAMPLE_*` env plumbing is removed.

**D6 — Acceptance emits a markdown results table to the run summary.** The builder
run shows the coverage table; the acceptance run shows only a one-line verdict.
Since the images and versioned libs are already published before acceptance runs,
the acceptance run should still make visible *what it verified*. `validate.py` runs
`run_all.py --json` (capturing the structured per-library results), and — driven
by import-all's per-track tallies plus that JSON — assembles a markdown table
(verdict header, import-all per track, per-library counts, and a "needs attention"
list of failing/errored libraries). It writes the table to the path in
`$LIB_STORE_SUMMARY_MD` when set. The table has to cross the container boundary
(the store lives inside the booted image, the step summary is on the runner):
`run.sh` gains `--summary-md <host-file>`, bind-mounts that file's dir writable at
`/out`, and sets `LIB_STORE_SUMMARY_MD=/out/<name>`; `lib-store-acceptance.sh`
passes a `$RUNNER_TEMP` path and, after the run, appends it to
`$GITHUB_STEP_SUMMARY` (no-op locally where that env is unset). Rationale for
capturing `--json` rather than modifying `run_all` to emit markdown: keeps the
combined import-all + validator table assembled in one place (`validate.py`, which
owns both signals) and leaves `run_all` a single-purpose runner. Alternative
(parse `run_all`'s text stdout) was rejected as brittle.

**D7 — Acceptance is a non-gating badge; the build owns `latest`.** The image
`:latest` tag is advanced by the build atomically and ungated (lib-store.yml's
`manifest` job), so acceptance never controlled the OSS artifact anyway; its only
lever was a per-arch S3 `latest/<arch>` copy on green. Per-arch tarball gating and
an atomic multi-arch image tag cannot be made coherent under best-effort arm64
(per-arch → `latest/amd64` and `latest/arm64` diverge; atomic all-arch → arm64
flakiness blocks amd64). Resolution: the **build** advances `latest/<arch>`
(manifest + coverage baseline) at publish, gated by its own load check + floor +
coverage regression guard — the same gate that decides whether it publishes —
mirroring the image `:latest` it already moves. **Acceptance** drops the S3 copy
entirely and becomes a non-gating validation: fresh-machine re-check +
per-arch results table + green/red status a maintainer reviews. Rationale: builds
are infrequent and reviewed by hand, so an automated gate buys little over a
manual check of a rich badge, and this collapses the two mismatched `latest`
concepts into one build-owned pointer. Alternatives considered: (a) atomic
all-arch acceptance gate — rejected, kills best-effort arm64; (b) manual promote
step after review — rejected as unnecessary machinery given infrequent builds.

## Risks / Trade-offs

- **[Runtime] 260 validators × per-script boot on the python-r image.** →
  `run_all` runs 8 in parallel with a 300 s per-script timeout; most either pass a
  quick op or hit the not-installed guard fast. Acceptable for a gate that already
  boots R + Bioconductor. `--jobs`/`--timeout` are tunable from `run.sh` if needed.
- **[Coverage gap] A library with no validator gets no behavioral check** — only
  import-all. → Acceptable and unchanged in spirit from anchors (which covered even
  fewer). import-all still guarantees it loads; adding validators is incremental.
- **[Import-shadowing] a `<pkg>.py` validator sits next to the real module.** →
  Already handled: each Python validator strips its own dir from `sys.path` before
  importing the package under test (see `scanpy.py`). No change needed.
- **[Ref-store probes at import] celltypist et al. read `$CELLTYPIST_FOLDER`.** →
  `run.sh` already provides a writable `--tmpfs /mnt/refs`; retained.
- **[Weaker guarantee] `latest` can advance to a store a validator later flags,
  since acceptance no longer gates.** → Deliberate (D7). The build floor (load
  check + non-empty floor + amd64 coverage-regression fail) is the automated gate;
  acceptance is the deep human-reviewed signal. Builds are infrequent, so a bad
  one is caught by review and fixed with a new build. If a hard gate is ever needed
  again, it belongs on the build, not a per-arch post-publish copy.

## Migration Plan

1. `git mv cli/scripts/lib-validator scripts/lib-validator` (history preserved).
2. Update the `.gitignore` comment that names the old path.
3. `validate.py`: drop the anchors + R-examples phases; add the `run_all` phase
   (`--lang` by `Rscript` presence) capturing `--json`; assemble the markdown table
   to `$LIB_STORE_SUMMARY_MD`; add `--no-validators`.
4. `run.sh`: mount `scripts/lib-validator`; add `--summary-md`; drop R-example
   flags/env.
5. `lib-store-acceptance.sh`: **remove the S3 promotion block**; pass `--summary-md`
   and append the table to `$GITHUB_STEP_SUMMARY`.
6. `lib-store-publish.sh`: advance `latest/<arch>/manifest.json` at publish; update
   the "candidate-only / latest NOT moved" prose.
7. `lib-store.yml` (builder): copy `coverage.json` to `latest/<arch>/` at publish.
8. `lib-store-acceptance.yml` (validator): "Validate + promote" → "Validate +
   report"; drop the promotion + AWS-role steps; render the table to the summary.
9. `git rm` `r_examples.R`, `anchors.json`, `anchors/`.
10. Apply the `lib-store-build` spec delta.

Rollback: revert the change commit — no data migration. Note this DOES change
publish behavior (the build now advances `latest`), so a rollback returns to the
acceptance-gated model.

## Open Questions

- None blocking. Optional future work: scope `run_all` to the advertised set to
  shave skip-noise from the log, if acceptance runtime becomes a concern.
