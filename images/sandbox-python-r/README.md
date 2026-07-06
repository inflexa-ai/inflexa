# sandbox-python-r

## Overview

[`sandbox-python`](../sandbox-python) + the **R libraries** (CRAN, Bioconductor,
GitHub). This is the top of the layered image ladder — the full analysis
environment. The R packages install into `/mnt/libs/current/r/{cran,bioconductor,
github}`, the same subtree the managed mount populates, so a baked image and a
mounted store present a byte-identical R library path.

## Run it

```sh
docker run --rm ghcr.io/inflexa-ai/inf-cli/sandbox-python-r:latest \
  Rscript -e 'library(Seurat); sessionInfo()'
```

The store is baked at `/mnt/libs/current` and the resolver env (`R_LIBS_SITE`
covering `r/{github,bioconductor,cran}`, plus the Python `.pth`, `NODE_PATH`, and
the conda `bin` on `PATH`) is inherited from `sandbox-python`, so a plain
`docker run` resolves imports for the baked R/Python/Node/conda packages with no
harness and no mount.

## Architecture support

The image is published for `linux/amd64` and (best-effort) `linux/arm64`. R on
amd64 installs fast via r2u (CRAN as `.deb` binaries); on arm64 (r2u is
amd64-only) CRAN falls back to a source compile and Bioconductor is source-only
and patchy, so the arm64 image is **best-effort** — whatever R actually builds
and loads is shipped, the rest is dropped and shows up in the build's coverage
report. If arm64 R does not build, no `sandbox-python-r` arm64 image is published;
`sandbox-python` (Python + conda + Node) still is.

## Extend it (`FROM`)

Same env-driven install targets as [`sandbox-python`](../sandbox-python) — see its
README. For R specifically, `R_LIBS_USER=$INFLEXA_LIB_ROOT/r/github` is the first
writable `.libPaths()` entry, so a downstream `RUN Rscript -e
'install.packages("mypkg")'` lands in the store:

```dockerfile
FROM ghcr.io/inflexa-ai/inf-cli/sandbox-python-r:latest
RUN Rscript -e 'install.packages("mypkg", repos="https://cloud.r-project.org")'
RUN inflexa-libs-refresh
```

Compiling R packages from source needs the toolchain — add `build-essential` and
the relevant `-dev` headers in your own `FROM` stage; the published image is lean.

## Build

Build from the **repo root**, passing the sandbox-python image it layers onto:

```sh
docker build -f images/sandbox-python-r/Dockerfile \
  --build-arg SANDBOX_PYTHON_IMAGE=sandbox-python:local \
  -t sandbox-python-r:local .
```

An R builder stage compiles/installs the CRAN → Bioconductor → GitHub triple
(sequential — they share one `.libPaths()` and a dependency chain, so they travel
together or not at all), runs the best-effort **load check**, then copies the
finished `r/` subtree into a lean `FROM sandbox-python` runtime stage and
regenerates `packages.txt`. Pass a `github_token` build secret to raise the
GitHub API budget for the GitHub R stage.

## Contributing

The package set lives in
[`../lib-store-manifest.yaml`](../lib-store-manifest.yaml). Keep the runtime stage
lean: the R build toolchain and r2u belong only in the builder stage.
