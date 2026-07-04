# syntax=docker/dockerfile:1
# Library store builder — installs all R, Python, Node packages and
# bioinformatics tools into /staging. The CI extracts each track subtree
# (plus its packages.txt fragment) as a separate library-store artifact.
#
# This is NOT a runtime image. It exists only to produce the store tarballs.
# Build deps (-dev packages, compilers) are included here but NOT in the
# sandbox-base runtime image.
#
# Uses r2u (CRAN as .deb binaries) for fast R package installs on amd64;
# on arm64 (r2u is amd64-only) CRAN falls back to source install. The arch
# matrix builds all six tracks on amd64 and the three non-R tracks
# (python/conda/node) on arm64 — see .github/workflows/lib-store.yml.
#
# Each track stage runs Gate 1 (a build-time load test): it import()/library()/
# require()s each installed package and FAILS the stage on a load failure, then
# writes that track's packages.txt fragment from the set that actually loaded —
# so the advertised set can never list a package that failed to load.
#
# Stages branch from base so independent tracks can build/fail independently.
# The workflow and scripts/build-libs-local.sh build each track stage and
# extract its subtree + fragment; there is no combined final/export stage.
#
#   base ──┬── cran → bioconductor → github  (R track — sequential)
#          ├── python                         (independent)
#          ├── system-tools                   (independent, conda)
#          └── node                           (independent)

ARG BASE_IMAGE=rocker/r-ver:4.6.0

# =============================================================================
# Stage: base — toolchain, package managers, output dirs
# =============================================================================
FROM ${BASE_IMAGE} AS base

# Build toolchain + dev headers (needed for Python C extensions
# and Bioconductor source compilation).
# Retries/timeouts: archive.ubuntu.com is on flaky round-robin mirrors;
# default zero retries occasionally drops the whole apt invocation.
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
      > /etc/apt/apt.conf.d/80-retries \
    && apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config gfortran make \
    python3-dev python3-venv \
    libbz2-dev liblzma-dev zlib1g-dev libzstd-dev libffi-dev \
    libssl-dev libxml2-dev libcurl4-openssl-dev libgit2-dev \
    libhdf5-dev libnetcdf-dev libopenblas-dev liblapack-dev \
    libeigen3-dev libfftw3-dev \
    libgdal-dev libgeos-dev libproj-dev libsqlite3-dev libudunits2-dev \
    libtiff-dev libjpeg-dev libpng-dev libgl1 libglib2.0-0 \
    libcairo2-dev libfreetype6-dev libfontconfig1-dev \
    libharfbuzz-dev libfribidi-dev \
    libpango1.0-dev libgdk-pixbuf-2.0-dev \
    libmagick++-dev libgsl-dev \
    swig \
    curl wget git jq \
    && rm -rf /var/lib/apt/lists/*

# r2u — CRAN packages as Ubuntu .deb binaries.
# Patch the keyserver to hkps:443 — the script's default (port 11371)
# times out regularly from CI runners.
RUN curl -fsSL https://raw.githubusercontent.com/eddelbuettel/r2u/master/inst/scripts/add_cranapt_noble.sh \
      -o /tmp/r2u_setup.sh \
    && sed -i 's|keyserver keyserver.ubuntu.com|keyserver hkps://keyserver.ubuntu.com:443|' /tmp/r2u_setup.sh \
    && bash /tmp/r2u_setup.sh \
    && rm /tmp/r2u_setup.sh

# Node.js for npm packages
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# uv for fast pip installs (pinned to match sandbox-base)
ENV UV_VERSION=0.7.12
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv

# micromamba for bioconda (TARGETARCH is set automatically by Docker buildx)
ARG TARGETARCH
RUN MAMBA_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "linux-aarch64" || echo "linux-64") \
    && curl -Ls "https://micro.mamba.pm/api/micromamba/${MAMBA_ARCH}/latest" \
    | tar -xvj -C /usr/local bin/micromamba 2>/dev/null || true

# pyyaml for reading the manifest (use uv, not pip — pip's apt postinst fails under QEMU)
RUN uv pip install --system --break-system-packages --no-cache pyyaml

# Output directories
RUN mkdir -p /staging/r/cran /staging/r/bioconductor /staging/r/github /staging/python/site-packages /staging/node/node_modules /staging/bin

COPY lib-store-manifest.yaml /tmp/manifest.yaml

# Gate 1 helper — the shared R load test used by the cran/bioconductor/github
# stages. Args: <section-title> <fragment-out> <pkg...>. It library()s each
# package, writes the section header + the comma-joined loadable set to the
# fragment file, and exits non-zero if ANY package fails to load (fail loud).
# The caller sets R_LIBS_SITE so packages resolve against the right /staging
# subtrees (a subset present is harmless — nonexistent libpaths are ignored).
RUN <<'RSCRIPT' cat > /usr/local/bin/lib-store-loadtest.R
args  <- commandArgs(trailingOnly = TRUE)
title <- args[1]
out   <- args[2]
pkgs  <- args[-(1:2)]
pkgs  <- unique(pkgs[nchar(pkgs) > 0])
ok <- character(0); failed <- character(0)
for (p in pkgs) {
  res <- tryCatch({ suppressPackageStartupMessages(library(p, character.only = TRUE)); TRUE },
                  error = function(e) { message(sprintf("LOAD-FAIL %s: %s", p, conditionMessage(e))); FALSE })
  if (isTRUE(res)) { ok <- c(ok, p); cat(sprintf("  OK: %s\n", p)) } else failed <- c(failed, p)
}
dir.create(dirname(out), recursive = TRUE, showWarnings = FALSE)
writeLines(c(paste0("## ", title), paste(sort(ok), collapse = ", "), ""), out)
if (length(failed) > 0) {
  cat(sprintf("ERROR: %d package(s) failed to load: %s\n", length(failed), paste(failed, collapse = ", ")))
  quit(status = 1)
}
cat(sprintf("Gate 1 OK: %d/%d %s package(s) loaded\n", length(ok), length(pkgs), title))
RSCRIPT

# =============================================================================
# Stage: cran — R CRAN packages
# On amd64: fast binary install via r2u .deb packages
# On arm64: source install via install.packages() (r2u is amd64-only)
# =============================================================================
FROM base AS cran

ARG TARGETARCH
RUN CRAN_PKGS=$(python3 -c "\
import yaml; \
m = yaml.safe_load(open('/tmp/manifest.yaml')); \
print('\n'.join(m.get('r',{}).get('cran',[])))" 2>/dev/null) \
    && if [ "$TARGETARCH" = "amd64" ]; then \
         echo "Installing CRAN packages via r2u (binary .deb)..." \
         && apt-get update -qq \
         && APT_PKGS=$(echo "$CRAN_PKGS" | while read -r pkg; do \
              [ -n "$pkg" ] && echo "r-cran-$(echo "$pkg" | tr '[:upper:]' '[:lower:]')"; \
            done | tr '\n' ' ') \
         && apt-get install -y --no-install-recommends $APT_PKGS > /tmp/cran-apt.log 2>&1 \
         && grep -E '^(Setting up|E:|Err:|dpkg:)' /tmp/cran-apt.log || true \
         && cp -a /usr/lib/R/site-library/* /staging/r/cran/ 2>/dev/null || true \
         && cp -a /usr/local/lib/R/site-library/* /staging/r/cran/ 2>/dev/null || true; \
       else \
         echo "Installing CRAN packages from source (r2u unavailable on $TARGETARCH)..." \
         && R -e "\
           pkgs <- trimws(strsplit('$(echo "$CRAN_PKGS" | tr "\n" ",")', ',')[[1]]); \
           pkgs <- pkgs[nchar(pkgs) > 0]; \
           install.packages(pkgs, lib='/staging/r/cran', repos='https://cloud.r-project.org', \
                            Ncpus=parallel::detectCores(), quiet=FALSE)" > /tmp/cran-install.log 2>&1 \
         && grep -E '^\* (installing|DONE)|^Error|^ERROR:|had non-zero|is not available' /tmp/cran-install.log || true; \
       fi \
    && test "$(ls /staging/r/cran | wc -l)" -gt 0 || { echo "ERROR: no CRAN packages installed"; [ -f /tmp/cran-install.log ] && tail -n 200 /tmp/cran-install.log; [ -f /tmp/cran-apt.log ] && tail -n 200 /tmp/cran-apt.log; exit 1; }

# Gate 1: library() every manifest CRAN package; fail loud on any load failure.
# Emits /staging/cran.packages.txt from the loadable set (not the wishlist).
RUN CRAN_PKGS=$(python3 -c "\
import yaml; \
m = yaml.safe_load(open('/tmp/manifest.yaml')); \
print('\n'.join(m.get('r',{}).get('cran',[])))" 2>/dev/null) \
    && R_LIBS_SITE=/staging/r/cran Rscript /usr/local/bin/lib-store-loadtest.R \
         "R (CRAN)" /staging/cran.packages.txt $CRAN_PKGS

# =============================================================================
# Stage: bioconductor — R Bioconductor packages (source compilation)
# =============================================================================
FROM cran AS bioconductor

# Stream install output live through an allow-based filter that drops only
# gcc/boost compile noise (RBGL's boost-template warnings alone blow past
# GHA's 4MB per-step cap). Original timestamps are preserved because each
# line passes through buildkit as R emits it. Full unfiltered output still
# goes to /tmp/*.log via tee for the failure tail-dump later.
#
# ANCOMBC is filtered out of the main batch — its Bioc 3.22 release (2.12.0)
# calls CVXR::solve, removed in CVXR 1.8. MSstats/MSstatsTMT are filtered out
# because MSstats pins CXX_STD=CXX11 but RcppArmadillo ≥14.2 requires C++14.
# DEP is filtered out because it isn't yet ported to Bioc devel (3.23 / R 4.6.0);
# we install it from the bioc-release r-universe mirror instead.
# With Ncpus>1, BiocManager uses `make -j` without -k, so one failed target
# aborts the batch and kills sibling workers mid-compile. Each is installed
# separately below with targeted workarounds.
RUN BIOC_PKGS=$(python3 -c "\
import yaml; \
m = yaml.safe_load(open('/tmp/manifest.yaml')); \
print(','.join([\"'\" + p + \"'\" for p in m.get('r',{}).get('bioconductor',[]) if p not in ('ANCOMBC','MSstats','MSstatsTMT','DEP')]))" 2>/dev/null || true) \
    && NOISE='/boost/|/Eigen/|/RcppEigen/|/RcppNumerical/|(required from|required by substitution|In instantiation of|skipping [0-9]+ instantiation)|^[^:]*:[0-9]+:[0-9]+: (warning|note):|^[[:space:]]+[0-9]+[[:space:]]+\||^[[:space:]]+\|[[:space:]]|OpenTelemetry error:' \
    && DOWNLOAD_FAIL='cannot open URL|download .* failed|HTTP status was|Failed to connect|Connection (timed out|refused)|Could not resolve host' \
    && retry_install() { \
         desc="$1"; log="$2"; shift 2; \
         attempt=1; max=3; \
         while [ "$attempt" -le "$max" ]; do \
           [ "$attempt" -gt 1 ] && { echo "--- Retry $attempt/$max for $desc (waiting $((attempt*15))s for transient origin outage) ---"; sleep $((attempt*15)); }; \
           { "$@" 2>&1 | tee "$log" | grep --line-buffered -vE "$NOISE"; } || true; \
           grep -qE "$DOWNLOAD_FAIL" "$log" || return 0; \
           attempt=$((attempt+1)); \
         done; \
         echo "--- $desc still hitting transient download failures after $max attempts; verification step will catch missing pkgs ---"; \
       } \
    && if [ -n "$BIOC_PKGS" ]; then \
       echo "--- Installing Bioconductor packages (ANCOMBC, MSstats, MSstatsTMT, DEP excluded) ---"; \
       { R -e "\
         .libPaths(c('/staging/r/bioconductor', '/staging/r/cran', .libPaths())); \
         if (!requireNamespace('BiocManager', quietly=TRUE)) install.packages('BiocManager', lib='/staging/r/cran', repos='https://cloud.r-project.org/'); \
         BiocManager::install(c($BIOC_PKGS), lib='/staging/r/bioconductor', ask=FALSE, update=FALSE, force=TRUE, Ncpus=parallel::detectCores())" 2>&1 \
         | tee /tmp/bioc-install.log \
         | grep --line-buffered -vE "$NOISE"; } || true; \
       echo "--- Installing ANCOMBC from r-universe (Bioc 3.22's 2.12.0 uses CVXR::solve which was removed in CVXR 1.8; r-universe serves patched 2.12.1) ---"; \
       retry_install "ANCOMBC (r-universe)" /tmp/bioc-ancombc.log R -e "\
         .libPaths(c('/staging/r/bioconductor', '/staging/r/cran', .libPaths())); \
         install.packages('ANCOMBC', lib='/staging/r/bioconductor', repos=c('https://bioc-release.r-universe.dev', BiocManager::repositories()))"; \
       echo "--- Installing DEP from frozen Bioc 3.22 source repo (DEP was dropped from Bioc 3.23; bioc-release.r-universe.dev rolled forward and no longer carries it) ---"; \
       retry_install "DEP (Bioc 3.22 frozen)" /tmp/bioc-dep.log R -e "\
         .libPaths(c('/staging/r/bioconductor', '/staging/r/cran', .libPaths())); \
         install.packages('DEP', lib='/staging/r/bioconductor', repos=c('https://bioconductor.org/packages/3.22/bioc', BiocManager::repositories()), dependencies=TRUE)"; \
       echo "--- Installing MSstats/MSstatsTMT (C++14 override for RcppArmadillo ≥14.2) ---"; \
       mkdir -p ~/.R && echo 'CXX11STD = -std=gnu++14' > ~/.R/Makevars; \
       retry_install "MSstats/MSstatsTMT" /tmp/bioc-msstats.log R -e "\
         .libPaths(c('/staging/r/bioconductor', '/staging/r/cran', .libPaths())); \
         BiocManager::install(c('MSstats','MSstatsTMT'), lib='/staging/r/bioconductor', ask=FALSE, update=FALSE, force=TRUE, Ncpus=parallel::detectCores())"; \
       rm -f ~/.R/Makevars; \
    fi \
    && echo "--- Capturing any bspm-apt-installed deps into /staging/r/bioconductor ---" \
    && cp -an /usr/lib/R/site-library/. /staging/r/bioconductor/ 2>/dev/null || true

# Gate 1: library() every manifest Bioconductor package; fail loud on any load
# failure. Emits /staging/bioconductor.packages.txt from the loadable set. On
# failure the shared script prints per-package LOAD-FAIL diagnostics; the full
# install log remains at /tmp/bioc-install.log for the failure tail-dump.
RUN BIOC_PKGS=$(python3 -c "\
import yaml; \
m = yaml.safe_load(open('/tmp/manifest.yaml')); \
print('\n'.join(m.get('r',{}).get('bioconductor',[])))" 2>/dev/null) \
    && { R_LIBS_SITE=/staging/r/bioconductor:/staging/r/cran Rscript /usr/local/bin/lib-store-loadtest.R \
           "R (Bioconductor)" /staging/bioconductor.packages.txt $BIOC_PKGS \
         || { echo "=== Error lines in /tmp/bioc-install.log ==="; \
              grep -n -B1 -A3 -E '^(ERROR:|Error:|installation of package .+ had non-zero|dependency .+ is not available)' /tmp/bioc-install.log 2>/dev/null || echo "(no explicit errors captured)"; \
              echo "=== Last 1000 lines of /tmp/bioc-install.log ==="; \
              tail -n 1000 /tmp/bioc-install.log 2>/dev/null || true; \
              exit 1; }; }

# =============================================================================
# Stage: github — R packages from GitHub (depends on CRAN + Bioconductor)
# =============================================================================
# Auth is required at scale: anonymous api.github.com is 60 req/hr per IP, and
# `remotes::install_github` with dependencies=TRUE burns several calls per
# repo (refs, tarball, DESCRIPTION) — 15 packages exhausts the window. CI
# mounts the GHA-issued GITHUB_TOKEN as a BuildKit secret (1k req/hr per repo),
# which `remotes` picks up via the GITHUB_PAT env var. `required=false` keeps
# the stage runnable locally without a token (with the anonymous limit caveat).
FROM bioconductor AS github

RUN --mount=type=secret,id=github_token,required=false \
    GH_PKGS=$(python3 -c "\
import yaml; \
m = yaml.safe_load(open('/tmp/manifest.yaml')); \
pkgs = m.get('r',{}).get('github',[]); \
print('\n'.join(pkgs) if pkgs else '')" 2>/dev/null || true) \
    && if [ -s /run/secrets/github_token ]; then \
         export GITHUB_PAT="$(cat /run/secrets/github_token)"; \
         echo "--- Using authenticated GitHub API (GITHUB_PAT set) ---"; \
       else \
         echo "--- WARN: no GITHUB_PAT mounted; anonymous API limit is 60 req/hr and will likely fail ---"; \
       fi \
    && NOISE='/boost/|/Eigen/|/RcppEigen/|/RcppNumerical/|(required from|required by substitution|In instantiation of|skipping [0-9]+ instantiation)|^[^:]*:[0-9]+:[0-9]+: (warning|note):|^[[:space:]]+[0-9]+[[:space:]]+\||^[[:space:]]+\|[[:space:]]|OpenTelemetry error:' \
    && TRANSIENT='HTTP error 403|API rate limit exceeded|cannot open URL|HTTP status was .50[0-9]|HTTP status was .429|Failed to connect|Connection (timed out|refused)|Could not resolve host|some files were not downloaded' \
    && if [ -n "$GH_PKGS" ]; then \
       echo "$GH_PKGS" | while read -r repo; do \
         [ -n "$repo" ] || continue; \
         attempt=1; max=4; \
         while [ "$attempt" -le "$max" ]; do \
           [ "$attempt" -gt 1 ] && { echo "--- Retry $attempt/$max for $repo (transient origin failure; waiting $((attempt*30))s) ---"; sleep $((attempt*30)); }; \
           echo "--- Installing R package from GitHub: $repo ---"; \
           { R -e "\
             .libPaths(c('/staging/r/github', '/staging/r/bioconductor', '/staging/r/cran', .libPaths())); \
             remotes::install_github('$repo', lib='/staging/r/github', dependencies=TRUE, upgrade='never')" 2>&1 \
             | tee /tmp/gh-install.log \
             | grep --line-buffered -vE "$NOISE"; } || true; \
           grep -qE "$TRANSIENT" /tmp/gh-install.log || break; \
           attempt=$((attempt+1)); \
         done; \
         if grep -qE 'had non-zero exit status|^ERROR: lazy loading failed|^Error: package or namespace load failed|HTTP error 403|API rate limit exceeded' /tmp/gh-install.log; then \
           echo "FAIL: $repo — install reported a failure:"; \
           tail -n 200 /tmp/gh-install.log; \
           exit 1; \
         fi; \
         if ! grep -qE "^\\* DONE|^Skipping install of" /tmp/gh-install.log; then \
           echo "FAIL: $repo — no install activity detected:"; \
           tail -n 200 /tmp/gh-install.log; \
           exit 1; \
         fi; \
         sleep 2; \
       done; \
    fi

# Gate 1: library() every package actually installed into the github libdir
# (its directory names are the real package names — repo basenames diverge, e.g.
# stuart-lab/signac -> Signac, mojaveazure/seurat-disk -> SeuratDisk). Fail loud
# on any load failure; emit /staging/github.packages.txt from the loadable set.
RUN GH_PKGS=$(ls /staging/r/github 2>/dev/null | tr '\n' ' ') \
    && R_LIBS_SITE=/staging/r/github:/staging/r/bioconductor:/staging/r/cran \
         Rscript /usr/local/bin/lib-store-loadtest.R \
           "R (GitHub)" /staging/github.packages.txt $GH_PKGS

# =============================================================================
# Stage: python — Python packages via uv (independent from R)
# =============================================================================
FROM base AS python

# --python pins uv to system Python so .so suffixes match the sandbox runtime.
# On arm64, strip [extras] from liana — pyscipopt needs the SCIP C library
# which has no arm64 .deb. Core liana functionality is unaffected.
ARG TARGETARCH
RUN python3 -c "\
import yaml, re, os; \
m = yaml.safe_load(open('/tmp/manifest.yaml')); \
pkgs = m.get('python',{}).get('pip',[]); \
arch = os.environ.get('TARGETARCH', 'amd64'); \
pkgs = [re.sub(r'\[extras\]', '', p) if 'liana' in p and arch != 'amd64' else p for p in pkgs]; \
print('\n'.join(pkgs))" > /tmp/requirements.txt 2>/dev/null || true \
    && if [ -s /tmp/requirements.txt ]; then \
       uv pip install --python /usr/bin/python3 --break-system-packages --no-cache \
         --target /staging/python/site-packages \
         -r /tmp/requirements.txt; \
    fi

RUN PYTHONPATH=/staging/python/site-packages python3 -c "\
from rpds.rpds import *; print('rpds OK'); \
import jsonschema; print('jsonschema OK'); \
import nbformat; print('nbformat OK')" \
    && echo "Python smoke tests passed"

# Pre-warm numba JIT cache, matplotlib font cache, and heavy import chains.
# Without this, `import scanpy` takes 10-20 min on first run because numba
# compiles its internals — and the lib store is mounted read-only in sandbox
# pods, so the cache can never be written at runtime.
# Each import runs independently so one LLVM/JIT crash doesn't block the rest.
#
RUN PYTHONPATH=/staging/python/site-packages \
    MPLCONFIGDIR=/staging/python/site-packages/matplotlib_config \
    bash -c '\
    ok=0; fail=0; \
    for pkg in numba matplotlib scanpy seaborn pertpy scvi cell2location; do \
      if python3 -c "import $pkg; print(f\"$pkg OK\")" 2>&1; then \
        ok=$((ok+1)); \
      else \
        echo "WARN: $pkg warm-up failed (non-fatal)"; \
        fail=$((fail+1)); \
      fi; \
    done; \
    echo "Cache warm-up: $ok OK, $fail failed"; \
    '

# Gate 1: import each manifest Python package and emit the fragment from what
# loads. Import module names are derived from installed dist metadata
# (top_level.txt / RECORD), so no hand-maintained pip->import alias map is
# needed — the same derivation is reused by the Gate 2 validator. Fail loud.
RUN <<'PYEOF' cat > /usr/local/bin/lib-store-py-loadtest.py
#!/usr/bin/env python3
"""Gate 1 Python load test: import each manifest pip package, fail loud, and
write /staging/python.packages.txt from the set that imported."""
import importlib
import importlib.metadata as im
import re
import sys

import yaml


def canonical(spec: str) -> str:
    """pip spec -> canonical distribution name (strip version/extras/markers)."""
    return re.split(r"[<>=!~;\[\s]", spec.strip())[0]


def modules_for(dist: str) -> list[str]:
    """Top-level import module names for an installed distribution."""
    try:
        d = im.distribution(dist)
    except im.PackageNotFoundError:
        return []
    txt = d.read_text("top_level.txt")
    mods = [l.strip() for l in txt.splitlines() if l.strip() and not l.startswith("_")] if txt else []
    if not mods:
        seen = set()
        for f in d.files or []:
            parts = f.parts
            if len(parts) == 1 and parts[0].endswith(".py") and not parts[0].startswith("_"):
                seen.add(parts[0][:-3])
            elif len(parts) >= 2 and parts[1] == "__init__.py":
                top = parts[0]
                if top and not top.startswith("_") and not top.endswith((".dist-info", ".data")):
                    seen.add(top)
        mods = sorted(seen)
    return mods


manifest = yaml.safe_load(open("/tmp/manifest.yaml"))
specs = manifest.get("python", {}).get("pip", [])
loaded: list[str] = []
failed: list[str] = []
for spec in specs:
    name = canonical(spec)
    if not name:
        continue
    mods = modules_for(name)
    if not mods:
        print(f"LOAD-FAIL {name}: no import module found (not installed?)")
        failed.append(name)
        continue
    last = ""
    for mod in mods:
        try:
            importlib.import_module(mod)
            print(f"  OK: {name}")
            loaded.append(name)
            break
        except Exception as e:  # noqa: BLE001 - any import error is a load failure
            last = f"{mod}: {type(e).__name__}: {e}"
    else:
        print(f"LOAD-FAIL {name}: {last}")
        failed.append(name)

with open("/staging/python.packages.txt", "w") as fh:
    fh.write("## Python (pip)\n" + ", ".join(sorted(loaded)) + "\n")

if failed:
    print(f"ERROR: {len(failed)} Python package(s) failed to import: {', '.join(failed)}")
    sys.exit(1)
print(f"Gate 1 OK: {len(loaded)}/{len(specs)} Python package(s) imported")
PYEOF

RUN PYTHONPATH=/staging/python/site-packages \
    MPLCONFIGDIR=/staging/python/site-packages/matplotlib_config \
    python3 /usr/local/bin/lib-store-py-loadtest.py

# =============================================================================
# Stage: system-tools — all bioinformatics CLI tools via bioconda
# =============================================================================
FROM base AS system-tools

# micromamba for bioconda (deterministic binary from official image)
# Installed here (not in base) to avoid busting the R/Python/Node stage caches.
COPY --from=mambaorg/micromamba:2.5.0 /bin/micromamba /usr/local/bin/micromamba

# Install all system_tools from the manifest into a single conda prefix.
# Strict channel priority prevents mixed conda-forge/bioconda dependency conflicts.
# Install directly at the runtime mount path (/mnt/libs/current/conda) so conda
# writes correct absolute shebangs and paths — no post-build rewriting needed.
RUN TOOLS=$(python3 -c "\
import yaml; \
m = yaml.safe_load(open('/tmp/manifest.yaml')); \
print(' '.join(m.get('system_tools',[])))" 2>/dev/null || true) \
    && if [ -n "$TOOLS" ]; then \
       micromamba create -y -p /mnt/libs/current/conda \
         --channel-priority strict \
         -c conda-forge -c bioconda \
         $TOOLS; \
       micromamba clean --all --yes; \
    fi

# Gate 1: every manifest system tool must resolve on PATH (a canned --version
# call is logged for visibility). Fail loud if any is missing; emit the
# packages.txt fragment from the tools that resolved. PATH must include the
# conda bin so tools like fastqc can find their bundled java.
ENV PATH="/mnt/libs/current/conda/bin:${PATH}"
RUN TOOLS=$(python3 -c "\
import yaml; \
m = yaml.safe_load(open('/tmp/manifest.yaml')); \
print('\n'.join(m.get('system_tools',[])))" 2>/dev/null) \
    && ok=""; failed=""; \
    for tool in $TOOLS; do \
      if command -v "$tool" >/dev/null 2>&1; then \
        ver=$("$tool" --version 2>&1 | head -1 || true); \
        echo "  OK: $tool ${ver}"; ok="$ok $tool"; \
      else \
        echo "LOAD-FAIL: $tool not found on PATH"; failed="$failed $tool"; \
      fi; \
    done; \
    printf '## System tools (CLI)\n%s\n' "$(printf '%s\n' $ok | sort | paste -sd', ' -)" \
      > /mnt/libs/current/conda.packages.txt; \
    if [ -n "$failed" ]; then echo "ERROR: system tool(s) failed Gate 1:$failed"; exit 1; fi; \
    echo "Gate 1 OK: system tools resolved"

# =============================================================================
# Stage: node — Node.js packages (independent)
# =============================================================================
FROM base AS node

RUN cd /staging/node && npm install echarts 2>&1 | tail -3

# Gate 1: require() each installed Node package; fail loud; emit the fragment
# from the set that loaded. (node/ carries a single direct dep, echarts; its
# transitive deps live under node_modules but are not advertised.)
RUN cd /staging/node && node -e '\
const pkgs = ["echarts"]; \
const bad = []; \
for (const p of pkgs) { \
  try { require(p); console.log("  OK: " + p); } \
  catch (e) { console.log("LOAD-FAIL " + p + ": " + e.message); bad.push(p); } \
} \
require("fs").writeFileSync("/staging/node.packages.txt", \
  "## Node (npm)\n" + pkgs.filter((p) => !bad.includes(p)).join(", ") + "\n"); \
if (bad.length) { console.error("ERROR: " + bad.length + " Node package(s) failed to load"); process.exit(1); } \
console.log("Gate 1 OK: " + (pkgs.length - bad.length) + "/" + pkgs.length + " Node package(s) loaded");'
