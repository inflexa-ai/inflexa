# Design — layered sandbox images

## The topology

```
 sandbox-base            lean: R/Python/Node runtimes + system libs
   (ghcr.io/inflexa-ai/inf-cli)     + sandbox-server + provenance hooks
                         /mnt/libs/current is EMPTY
        │ FROM                     ▲
        ▼                          │ managed mounts the tarballs OVER this
 sandbox-python          + Python libs            → /mnt/libs/current/python
   (ghcr.io/inflexa-ai/inf-cli)     + bioconda CLI tools     → /mnt/libs/current/conda
                         + Node packages          → /mnt/libs/current/node
        │ FROM
        ▼
 sandbox-python-r        + R libs (cran/bioc/github) → /mnt/libs/current/r/*
   (ghcr.io/inflexa-ai/inf-cli)

 all 3 images × { linux/amd64, linux/arm64 } → ghcr.io/inflexa-ai/inf-cli

 after publish:  boot image → tar each /mnt/libs/current/<track> subtree
                 → per-track content-addressed tarball + per-arch manifest → S3
                 (the managed mount artifacts — a BYPRODUCT of the images)
```

Two consumers, one build:

- **User (OSS):** `docker run inflexa/sandbox-python-r` — `/mnt/libs/current` is
  baked, the resolver env is baked, zero pull, zero mount. Or `FROM` it and add
  libs.
- **Managed:** runs lean `sandbox-base` and mounts the extracted tarballs
  read-only at `/mnt/libs` — the cold-start-friendly path, unchanged from today.

## Decision 1 — install to `/mnt/libs/current/…`, not native paths

Every layer installs to the exact path the managed mount uses. Consequence: a
baked image and a mounted store present a **byte-identical** runtime layout, so
the harness `lib-store` runtime contract does not change. The conda track already
installs to `/mnt/libs/current/conda` and the Python `.pth` already points at
`/mnt/libs/current/python/site-packages` today, so this extends an existing
convention rather than inventing one.

Rejected: installing to native locations (`/usr/lib/R/site-library`, system
site-packages). It reads more "normal" for a `FROM` user, but it forks the
runtime env between the baked (user) and mounted (managed) worlds and forces the
harness to support two layouts. Not worth it.

## Decision 2 — base stays lean; bioconda rides up into `sandbox-python`

A few hundred MB of conda CLI tools in **base** is a real per-node cold-start tax
on managed, and base is exactly the image managed pulls per node. So base carries
**no** analysis packages, and the bioconda tools ride up with Python into
`sandbox-python`. The image name stays `sandbox-python` (not `-python-bioconda`):
the ladder communicates a *ceiling* (python-capable vs python+R-capable); the CLI
tools are a *floor* any real bioinformatics tier wants, documented in the tag/README
rather than spelled into the name. A separate `sandbox-tools` tier would only pay
off for users who want Python libs but explicitly not the conda tools — not a real
audience, and moot for managed, which mounts tracks independently of image layering.

## Decision 3 — images are self-sufficient (bake the resolver env)

Today the resolver env (`R_LIBS_SITE`, `NODE_PATH`, `PATH`+conda `bin`) is
injected by the *harness mount plan*, and only when a mount is configured; only
the Python `.pth` is baked. A baked image run without a mount would then get no R/
Node resolution. So the images **bake the resolver env as `ENV`** and bake
`/mnt/libs/current/packages.txt`. Because baked and mounted paths are identical,
this is safe for managed too (redundant with, never conflicting with, the harness
injection). The harness stays unchanged; self-sufficiency is a property of the
image. This is what makes `docker run` "just work" with no harness in the loop.

## Decision 4 — `FROM`-extension via env-driven install targets

Runtime resolution is free for a downstream image (it inherits the baked env).
The only friction is *install-time targeting*. We remove it with one knob plus
per-installer defaults, all pointing into the store:

- `INFLEXA_LIB_ROOT=/mnt/libs/current` — single source of truth; the resolver
  env derives from it.
- `PIP_TARGET=$INFLEXA_LIB_ROOT/python/site-packages` → `pip install X` lands in
  the store.
- `R_LIBS_USER=$INFLEXA_LIB_ROOT/r/github` (first writable `.libPaths()` entry)
  → `install.packages("X")` lands in the store.
- npm prefix at `$INFLEXA_LIB_ROOT/node` → `npm install X` lands in the store.
- conda/mamba already take `-p $INFLEXA_LIB_ROOT/conda`.

So a contributor's Dockerfile is `FROM inflexa/sandbox-python-r` then `RUN pip
install mypkg` — no path knowledge, resolves at runtime. A small
`inflexa-libs-refresh` helper re-derives `packages.txt` so the additions surface
in `list_available_packages` (otherwise the tool under-reports them).

## Decision 5 — best-effort load check + non-empty floor + coverage report

The manifest declares *wants*; each arch gets *what it can build*.

- **Load check** (was Gate 1): `import`/`library()`/`require()`/`--version` each
  package in the image build, derive that track's `packages.txt` fragment from
  what loaded. A single package failure no longer fails the track.
- **Non-empty floor:** a track that loaded **zero** packages is a real failure —
  do not publish a degenerate/empty tarball for it.
- **Coverage report:** after the build, one printed table — per arch × track:
  wanted / loaded / missing — and a diff against the last published manifest.
  amd64 is the primary target, so a package that *used to* ship for amd64 and
  silently dropped is a **regression (red)**; an arm64 package that never built
  is **tolerated (informational)**. This keeps best-effort from hiding amd64 rot.

This makes the design's existing "packages.txt derives per arch from what
actually loaded" claim actually true for R, where strict fail-loud previously
contradicted it.

## Decision 6 — acceptance still gates `latest`; may also boot the image

**Acceptance** (was Gate 2) is unchanged in intent: on a fresh machine, obtain
the store the way a user does, run the extensive suite (import-all invariant,
compiled-anchor real-ops, network-filtered R examples), promote `latest` only on
green. New option: because the images are self-sufficient, acceptance can *also*
boot each published image directly (baked, no mount) and run the same suite — the
image is what OSS users actually consume, so validating it closes the loop the
pull-as-user path alone does not.

## Decision 7 — GHCR registry, and the CLI pulls an image (not tarballs)

The three images publish to **GitHub Packages (GHCR) on `inflexa-ai/inf-cli`**
(`ghcr.io/inflexa-ai/inf-cli/sandbox-base|sandbox-python|sandbox-python-r`) — no
extra registry account, auth reuses the repo's GITHUB_TOKEN in CI.

This flips the CLI's local-setup model, so it lands as a **companion
`cli/openspec` change**:

- The local user no longer pulls/assembles tarballs. They **choose a variant**
  (`python` or `python-r`), the CLI `docker pull`s
  `ghcr.io/inflexa-ai/inf-cli/sandbox-<variant>`, and sets `harness.sandboxImage`
  to it. Sandboxes then launch on the baked image — no local store dir, no
  `/mnt/libs` bind mount, no client-side `packages.txt` assembly.
- `ensureSandboxImage` changes from "not found → tell the user to `docker build`"
  to "not found → `docker pull` from GHCR".
- The per-track tarball client (`cli/src/modules/libs/{pull,store,manifest,arch}`)
  is **retired for the local path**. The tarballs remain **managed-only**, mounted
  by infra via the Kubernetes PVC — not the CLI's concern anymore.
- Multi-arch image manifests mean docker pulls the host arch automatically, so the
  old "force the sandbox platform from the store's recorded arch" logic collapses
  to docker's default; explicit platform-forcing is dropped for the local path.

The split keeps the two worlds clean: **CLI/local = image**, **managed = mounted
tarball**, both built from the same three images.

## Naming migration

| Old | New | Where |
|-|-|-|
| Gate 1 | load check | Dockerfile comments, `*-loadtest.*` (files already fine) |
| (new) | coverage report | new build step + report |
| Gate 2 | acceptance | `lib-store-gate2.sh` → `lib-store-acceptance.sh`, `validate-lib-store.yml` prose, README/spec |

## arm64 R — attempted, mechanism out of scope

r2u is amd64-only, so arm64 CRAN is a source compile (fallback path already
exists in the builder) and Bioconductor on aarch64 is source-only and patchy.
Best-effort + floor + coverage report is precisely what makes this shippable:
whatever compiles and loads is advertised; the rest drops and shows up in the
report. **How** the arm64 build is produced — a native arm64 runner vs. QEMU
emulation on the amd64 self-hosted box — is an infrastructure decision and is out
of scope for this spec, which only requires that both arches attempt every track
best-effort.

## Runtime contract — explicitly unchanged

`/mnt/libs/current`, one `packages.txt`, the resolver env, `list_available_packages`,
"no runtime installs in a managed sandbox" — all identical. The harness cannot
tell a baked image from a mounted store, by construction. This change is entirely
in the **build/publish** layer plus the images themselves.
