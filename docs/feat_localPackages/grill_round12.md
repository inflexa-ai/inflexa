# Grill round 12 — the image hygiene points

Date: 2026-08-20. The user raised four points on the committed image work.
This document holds the facts behind the round-12 questions.

## 1. The seed file

- `images/sandbox-base/inflexa-seed-caches:1` — the file is POSIX shell. The
  first line is `#!/bin/sh`.
- `images/sandbox-base/Dockerfile:500` — the image puts the file at
  `/usr/local/bin/inflexa-seed-caches`.
- `images/sandbox-base/Dockerfile:496-499` — each caller sources the file. No
  caller executes it. It has no execute bit.

The name obeys the `bin` convention, and that convention drops the extension
of a command. But the file is a sourced library, not a command. Thus the
location is the larger fault, not the name.

## 2. The inline scripts and the comments

The sandbox-base Dockerfile holds four inline programs:

- `Dockerfile:88-98` — the Python reader of the conda tool list.
- `Dockerfile:118-124` — the Python reader of the load-check names, with the
  `binaries` map.
- `Dockerfile:169-172` — the Python reader of the node list.
- `Dockerfile:183-194` — the Node load check, through `node -e`.

The conda builder and the node builder both branch from the libs-toolchain
stage. Thus one COPY in that stage can carry a `scripts/` directory to the
four sites. An extracted file also becomes a target for a linter.

The Dockerfile is a new file of this branch. Thus STE controls its comments.
Some comment sentences pass the 25-word cap, for example
`Dockerfile:380-383`. Some hold a semicolon or a passive chain, for example
`Dockerfile:100-103`.

## 3. The version audit

The upstream versions come from a fetch on 2026-08-20. The pins came from the
previous lib-store image, not from a fresh choice.

| Pin | Where | Upstream | Assessment |
| --- | --- | --- | --- |
| uv 0.7.12 | base:293, provisioner:57 | 0.12.5 | Stale. The two pins move together. |
| ruff 0.16.0 | base:294 | 0.16.3 | Near current. |
| tailwindcss v4.1.4 | base:308 | v4.3.3 | Behind. A bump takes the new SHA-256 sums. |
| micromamba 2.5.0 | base:83 | 2.9.0 | Behind. Build-time only. |
| Node.js 20 | base:163, base:285 | lines 22 and 24 | EOL since 2026-04-30. |
| golang 1.26-bookworm | base:32 | go1.27.0 | Supported. Dependabot tracks the FROM line. |
| gcc bookworm | base:44 | — | Digest-pinned. Dependabot tracks the FROM line. |
| rocker/r-ver 4.6.0 | manifest:20, base:23, provisioner:21 | 4.6.1 | A patch exists. |

Notes:

- `provisioner:55-56` gives the reason for the shared uv pin. The resolution
  and the wheel selection must match the runtime image.
- Node line 20 reached its end of life on 2026-04-30. Line 22 ends on
  2027-04-30. Line 24 is the active LTS, and it ends on 2028-04-30.
- A rocker bump moves the pinned CRAN snapshot of the base. Thus it forces a
  full store re-resolve and a full rebuild.
- The Dependabot docker updater reads the FROM lines only
  (`.github/dependabot.yml`). The ENV pins, the curl installers, and the
  manifest `base_image` stay manual. `manifest.yaml:18-19` records the
  manifest gap.
- No committed lock exists yet. Thus a uv bump today causes no resolution
  churn against a lock.

## 4. The manifest versions

- `docs/feat_localPackages/decisions.md:53-60` — the recorded decision. The
  manifest is the intent layer, and a constraint is optional. The build
  resolves per arch, and the workflow commits the lock files back.
- `harness/openspec/changes/package-store-rebuild/specs/lib-store-build/spec.md:58`
  — resolution obeys the manifest first and the lock second.
- `.github/workflows/package-store-build.yml:201-224` — the lock lands at
  `images/package-store/lock.<arch>.json`. The commit-back job commits it
  with a sign-off.
- The locks are absent today, because the first dispatch did not run.
- A constraint exists where an intent exists. Examples: `manifest.yaml:546`
  (`spectrum-utils>=0.5`) and `manifest.yaml:656` (`samtools=1.22.1`).

Thus the design puts the exact version of each package in the committed lock,
with its hash. No grill round recorded a per-entry pin in the manifest. If
that requirement now stands, the decision changes:

- The schema makes the constraint mandatory per entry.
- About 290 legacy entries take hand-written constraints.
- Each refresh then fights the constraints, but the lock still holds the real
  pin.

## The decisions of round 12

The user settled the four questions on 2026-08-20:

- Q1: the seed file becomes `inflexa-seed-caches.sh`, and the image puts it
  at `/usr/local/lib/`.
- Q2: the four inline programs move to `images/sandbox-base/scripts/`, and
  the comments of the Dockerfile obey STE.
- Q3: uv 0.12.5 in the two Dockerfiles, ruff 0.16.3, tailwindcss v4.3.3 with
  its new sums, micromamba 2.9.0, and Node.js 24. golang and gcc stay with
  Dependabot. The rocker 4.6.1 bump waits for its own change, after the
  first store build lands.
- Q4: the committed lock stays the pin layer. The manifest keeps the
  optional constraint.
