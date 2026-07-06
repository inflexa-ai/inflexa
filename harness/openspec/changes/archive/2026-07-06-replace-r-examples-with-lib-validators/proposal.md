## Why

Two problems, one change.

**The behavioral pass is weak.** Acceptance's deep behavioral pass is today a
network-filtered run of each R package's *own* examples (`r_examples.R`) plus a
small curated set of "anchor" operations (`anchors.json` + `anchors/`). The
R-examples pass is heavy, flaky (examples assume network, fixtures, or
`\donttest` state we then denylist), and R-only — Python libraries get no
behavioral coverage at all. The anchor set is a handful of hand-picked ops
maintained by hand. We now have a purpose-built, self-contained per-library
smoke-test suite (`lib-validator/`, ~260 `<pkg>.R` / `<pkg>.py` + `run_all.py`):
each script guards on not-installed, then runs real API operations on synthetic
data with structural tolerances, reporting PASS / NOT_INSTALLED / FAIL / ERROR.
It covers both R **and** Python at far greater breadth, with none of the
network/fixture flakiness.

**The validator's promotion role is incoherent.** Acceptance's only teeth are a
per-arch S3 copy that advances `latest/linux-<arch>` on green. But the primary
OSS artifact — the image `:latest` tag `inflexa sandbox pull` fetches — is a
single multi-arch tag the *build* already advances atomically and ungated, before
acceptance runs. So there are two `latest` concepts with mismatched semantics
(image = build-owned / atomic / ungated; tarball = acceptance-owned / per-arch /
gated), and they cannot be reconciled with best-effort arm64: a per-arch gate lets
`latest/amd64` and `latest/arm64` diverge, and an atomic all-arch gate would let
patchy arm64 block amd64. Builds are infrequent and reviewed by hand, so the clean
resolution is to let the **build** own `latest` (as it already does for the image)
and make **acceptance a non-gating, human-reviewed validation** — a badge that
reports exactly what it verified.

## What Changes

- **Move** the validator suite from `cli/scripts/lib-validator/` to
  `scripts/lib-validator/`, preserving the subfolder.
- **Wire** `run_all.py` into the acceptance suite as its behavioral phase: it runs
  the per-library validators inside the booted image, counting an
  installed-but-broken library as a failure and an absent library as a skip.
- **Remove** the R-examples pass — delete `r_examples.R` and the `--r-examples` /
  `--full` path in `validate.py` / `run.sh` / `lib-store-acceptance.sh`.
- **Remove** the anchors registry — delete `anchors.json` and `anchors/`, and the
  anchors phase in `validate.py`.
- **Keep** the import-all invariant (advertised ⊆ loadable) as part of what
  acceptance checks and reports. It is no longer a *promotion* gate (nothing is
  gated at acceptance anymore) — the build's own load check enforces advertised ⊆
  loadable at publish; acceptance re-checks it on a fresh machine and reports.
- **BREAKING (promotion model): acceptance stops moving `latest`.** Delete the S3
  promotion from `lib-store-acceptance.sh` and the acceptance workflow. Acceptance
  becomes a non-gating validation: run the suite, emit a per-arch results table to
  the run summary, exit green/red as a reviewable status. It mutates nothing.
- **The build advances `latest/linux-<arch>` itself**, at publish, gated by the
  build's existing load check + non-empty floor + coverage regression guard —
  mirroring the image `:latest` tag it already advances. `lib-store-publish.sh`
  writes `latest/<arch>/manifest.json` (and the coverage baseline) alongside the
  immutable `<version>/` tree.
- **Add visibility to the acceptance run**: `validate.py` assembles a markdown
  results table (import-all per track + per-library validator counts and the
  failing/errored libraries) written to `$LIB_STORE_SUMMARY_MD`; the acceptance
  workflow appends it to `$GITHUB_STEP_SUMMARY`.
- **Unchanged**: the coverage report (`lib-store-coverage.py`), the build-time
  load check + floor, tarball packing, and the `inflexa sandbox pull` path.

## Capabilities

### New Capabilities
<!-- none — reshapes existing lib-store-build requirements -->

### Modified Capabilities
- `lib-store-build`:
  - MODIFIED "Builds publish immutable versions selected by a manifest" — each
    successful build now advances `latest/linux-<arch>` (manifest + coverage
    baseline), gated by the build floor, not deferred to acceptance.
  - REMOVED "latest advances only to a validated version" — acceptance no longer
    gates promotion (see Migration in the delta).
  - ADDED "Acceptance is a non-gating post-publish validation" — acceptance
    validates the published store on a fresh machine (import-all invariant +
    per-library smoke tests), surfaces a per-arch results table + green/red
    status, and mutates nothing.

## Impact

- **Scripts (`scripts/`)**:
  - New location `scripts/lib-validator/` (moved from `cli/scripts/lib-validator/`).
  - `lib-store-validate/validate.py`: drop the anchors + R-examples phases; add
    the `run_all.py` behavioral phase (`--lang py` when `Rscript` absent, else
    `--lang all`); assemble the markdown results table to `$LIB_STORE_SUMMARY_MD`;
    keep import-all; add a `--no-validators` fast-core escape hatch.
  - `lib-store-validate/run.sh`: mount `scripts/lib-validator/` at `/opt/lib-validator`;
    add `--summary-md <host-file>` (writable bind mount + `LIB_STORE_SUMMARY_MD`);
    drop `--full` / `--r-examples` / `--no-anchors` and the `LIB_STORE_R_EXAMPLE_*` env.
  - `lib-store-acceptance.sh`: **remove the S3 promotion block**; run the suite,
    pass `--summary-md`, append the table to `$GITHUB_STEP_SUMMARY`; no longer
    needs `S3_BUCKET`/AWS creds.
  - `lib-store-publish.sh`: **advance `latest/<arch>/manifest.json`** (and the
    coverage baseline) at publish; update the "candidate-only / latest NOT moved"
    prose.
  - **Deleted**: `lib-store-validate/r_examples.R`, `anchors.json`, `anchors/`.
- **CI**:
  - `lib-store.yml` (builder): copy `coverage.json` to `latest/<arch>/` at publish
    (baseline now advances with the build).
  - `lib-store-acceptance.yml` (validator): "Validate + promote" → "Validate +
    report"; drop the promotion + AWS-role steps; render the results table to the
    step summary.
- **Spec**: `harness/openspec/specs/lib-store-build/spec.md` — the immutable-publish
  requirement gains latest-advances; the acceptance-gate requirement is removed and
  replaced with a non-gating validation requirement.
- **Not touched**: `lib-store-coverage.py` logic, the load check, tarball packing,
  `inflexa sandbox pull`.
