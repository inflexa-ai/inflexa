# syntax=docker/dockerfile:1
# sandbox-python-r — sandbox-python + the R libraries (CRAN, Bioconductor,
# GitHub). The R packages install into /mnt/libs/current/r/{cran,bioconductor,
# github} — the same subtree the managed mount populates — so a baked image and
# a mounted store present a byte-identical R library path.
#
# Multi-stage: a throwaway R builder carries the R build toolchain + r2u and
# compiles/installs the R triple into the store; the final runtime stage is
# `FROM sandbox-python` and only COPYs the finished r/ subtree + fragments in,
# then regenerates packages.txt. No build toolchain reaches the runtime layer.
#
# The R triple travels together or not at all: cran → bioconductor → github share
# one .libPaths() and form a dependency chain, so a failed earlier track aborts
# the later ones (and, on arm64 where the R source compile is patchy, the whole
# sandbox-python-r build for that arch — best-effort per arch, handled by CI).
#
# Uses r2u (CRAN as .deb binaries) for fast R installs on amd64; on arm64 (r2u is
# amd64-only) CRAN falls back to source install. Each track runs a best-effort
# LOAD CHECK: library() each package, derive the fragment from what loaded, drop
# a single failure, fail the build only when a track loaded ZERO packages (floor).
#
# Build context is the repo ROOT (so COPY can reach images/lib-store-manifest.yaml).

# The published sandbox-python this image layers onto. CI overrides it with the
# locally-built/loaded tag; the default is the GHCR-published image.
ARG SANDBOX_PYTHON_IMAGE=ghcr.io/inflexa-ai/sandbox-python:latest
# R builder base — MUST match sandbox-base's R runtime so the compiled R
# packages' ABI matches (same R 4.6.0). Pinned by digest to match sandbox-base
# and images/lib-store-manifest.yaml; CI overrides it with the manifest value
# (also digest-pinned).
ARG BASE_IMAGE=rocker/r-ver:4.6.0@sha256:6f05a1a8b8c52328f181593923909b01cbfd14c9caea93bf75ddc65e806d8eac
ARG INFLEXA_LIB_ROOT=/mnt/libs/current

# Cap on parallel R package compiles (install.packages/BiocManager Ncpus). Empty
# means auto (parallel::detectCores()). Set e.g. --build-arg R_NCPUS=4 on a
# memory-constrained builder to keep concurrent source compiles from OOMing.
ARG R_NCPUS=

# =============================================================================
# Stage: r-toolchain — R build deps, r2u, the manifest, the load-check helper.
# =============================================================================
FROM ${BASE_IMAGE} AS r-toolchain
ARG INFLEXA_LIB_ROOT

# Build toolchain + dev headers for Bioconductor source compilation. The apt
# build-dep set + retry config is shared with sandbox-python; python3-yaml (the
# system-python YAML the manifest parse reads) installs in the same apt
# transaction as a stage-specific extra.
#
# The jags/libuv1t64/libprotobuf32t64/libglpk40 runtime .so set mirrors what
# sandbox-base ships, and exists here for the load checks below — which run in this
# builder, NOT in the runtime image. rjags/fs/otelsdk/igraph are binaries that
# dyn.load these at library() time, so omitting them makes the checks report a DROP
# (and omit the package from packages.txt) for packages that are in fact fine in the
# shipped image. Keep in sync with the runtime list in images/sandbox-base/Dockerfile:
# a lib there but missing here reappears as a phantom arch-specific coverage gap.
# On amd64 the r2u apt path pulls these in as transitive Depends; the arm64 P3M path
# resolves no system libs at all, so they must be named explicitly.
COPY images/install-build-toolchain.sh /tmp/install-build-toolchain.sh
RUN bash /tmp/install-build-toolchain.sh python3-yaml jags libuv1t64 libprotobuf32t64 libglpk40

# r2u — CRAN packages as Ubuntu .deb binaries. Patch the keyserver to hkps:443
# — the script's default (port 11371) times out regularly from CI runners.
RUN curl -fsSL https://raw.githubusercontent.com/eddelbuettel/r2u/master/inst/scripts/add_cranapt_noble.sh \
      -o /tmp/r2u_setup.sh \
    && sed -i 's|keyserver keyserver.ubuntu.com|keyserver hkps://keyserver.ubuntu.com:443|' /tmp/r2u_setup.sh \
    && bash /tmp/r2u_setup.sh \
    && rm /tmp/r2u_setup.sh

COPY images/lib-store-manifest.yaml /tmp/manifest.yaml

RUN mkdir -p ${INFLEXA_LIB_ROOT}/r/cran ${INFLEXA_LIB_ROOT}/r/bioconductor ${INFLEXA_LIB_ROOT}/r/github

# Injection guard (defense-in-depth). R names are interpolated into R string
# literals — install.packages('<name>'), install_github('<repo>') — where a quote
# or backslash could break out. Reject any R name outside the safe charset once
# here (every track branches from this stage).
RUN python3 - <<'PYEOF'
import re, sys, yaml
m = yaml.safe_load(open("/tmp/manifest.yaml")) or {}
r = m.get("r", {}) or {}
safe = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/@#-]*$")
bad = [n for grp in ("cran", "bioconductor", "github") for n in (r.get(grp) or []) if not safe.match(str(n))]
if bad:
    print("ERROR: R package name(s) outside the safe charset (shell/R injection guard):", file=sys.stderr)
    for b in bad:
        print(f"  - {b!r}", file=sys.stderr)
    sys.exit(1)
print("manifest R-name injection guard: all cran/bioconductor/github names within the safe charset")
PYEOF

# Best-effort R load check — library() each package, write the fragment from the
# loadable set, drop a single failure, fail only when ZERO loaded (the non-empty
# floor). The caller sets R_LIBS_SITE so packages resolve against the right store
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
                  error = function(e) { message(sprintf("DROP %s: %s", p, conditionMessage(e))); FALSE })
  if (isTRUE(res)) { ok <- c(ok, p); cat(sprintf("  OK: %s\n", p)) } else failed <- c(failed, p)
}
dir.create(dirname(out), recursive = TRUE, showWarnings = FALSE)
writeLines(c(paste0("## ", title), paste(sort(ok), collapse = ", "), ""), out)
if (length(failed) > 0) cat(sprintf("NOTE: %d %s package(s) dropped: %s\n", length(failed), title, paste(failed, collapse = ", ")))
if (length(ok) == 0) {
  cat(sprintf("ERROR: the %s track loaded ZERO packages (non-empty floor) — failing the build.\n", title))
  quit(status = 1)
}
cat(sprintf("Load check OK: %d/%d %s package(s) loaded\n", length(ok), length(pkgs), title))
RSCRIPT

# =============================================================================
# Stage: cran — R CRAN packages. Binary on both arches, by different routes.
#   amd64: r2u .deb packages via apt (r2u is amd64-only). apt resolves each
#          package's system libraries transitively, so they come in for free.
#   arm64: install.packages() with NO repos= override. rocker/r-ver pins repos to
#          a P3M snapshot and sets an HTTPUserAgent carrying the platform triple;
#          that UA is what makes P3M serve prebuilt aarch64 binaries. Naming any
#          repo here (e.g. cloud.r-project.org) drops that UA and silently falls
#          back to ~300 source builds, which fail on every package needing a system
#          -dev header: fs (uv.h), gmp, symengine, rjags, clarabel, otelsdk.
#          Inheriting the option also keeps the snapshot in lockstep with BASE_IMAGE.
#          Unlike the r2u path, P3M binaries do NOT pull system libs — anything
#          with a runtime .so (e.g. rjags → libjags) needs it in the apt list above.
# =============================================================================
FROM r-toolchain AS cran
ARG INFLEXA_LIB_ROOT
ARG TARGETARCH
ARG R_NCPUS

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
         && cp -a /usr/lib/R/site-library/* ${INFLEXA_LIB_ROOT}/r/cran/ 2>/dev/null || true \
         && cp -a /usr/local/lib/R/site-library/* ${INFLEXA_LIB_ROOT}/r/cran/ 2>/dev/null || true; \
       else \
         echo "Installing CRAN packages via the base image's P3M snapshot (binary) on $TARGETARCH..." \
         && R -e "\
           pkgs <- trimws(strsplit('$(echo "$CRAN_PKGS" | tr "\n" ",")', ',')[[1]]); \
           pkgs <- pkgs[nchar(pkgs) > 0]; \
           install.packages(pkgs, lib='${INFLEXA_LIB_ROOT}/r/cran', \
                            Ncpus=${R_NCPUS:-parallel::detectCores()}, quiet=FALSE)" > /tmp/cran-install.log 2>&1 \
         && grep -E '^\* (installing|DONE)|^Error|^ERROR:|had non-zero|is not available' /tmp/cran-install.log || true; \
       fi \
    && test "$(ls ${INFLEXA_LIB_ROOT}/r/cran | wc -l)" -gt 0 || { echo "ERROR: no CRAN packages installed"; [ -f /tmp/cran-install.log ] && tail -n 200 /tmp/cran-install.log; [ -f /tmp/cran-apt.log ] && tail -n 200 /tmp/cran-apt.log; exit 1; }

# Best-effort load check → ${INFLEXA_LIB_ROOT}/cran.packages.txt.
RUN CRAN_PKGS=$(python3 -c "\
import yaml; \
m = yaml.safe_load(open('/tmp/manifest.yaml')); \
print('\n'.join(m.get('r',{}).get('cran',[])))" 2>/dev/null) \
    && R_LIBS_SITE=${INFLEXA_LIB_ROOT}/r/cran Rscript /usr/local/bin/lib-store-loadtest.R \
         "R (CRAN)" ${INFLEXA_LIB_ROOT}/cran.packages.txt $CRAN_PKGS

# =============================================================================
# Stage: bioconductor — R Bioconductor packages (source compilation).
# =============================================================================
FROM cran AS bioconductor
ARG INFLEXA_LIB_ROOT
ARG R_NCPUS

# Stream install output live through an allow-based filter that drops only
# gcc/boost compile noise (RBGL's boost-template warnings alone blow past GHA's
# 4MB per-step cap). Full unfiltered output goes to /tmp/*.log via tee for the
# failure tail-dump.
#
# ANCOMBC is filtered out of the main batch — its Bioc 3.22 release (2.12.0)
# calls CVXR::solve, removed in CVXR 1.8. MSstats/MSstatsTMT are filtered out
# because MSstats pins CXX_STD=CXX11 but RcppArmadillo ≥14.2 requires C++14.
# DEP is filtered out because it isn't yet ported to Bioc devel (3.23 / R 4.6.0);
# we install it from the bioc-release r-universe mirror instead. Each is installed
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
         echo "--- $desc still hitting transient download failures after $max attempts; the load check will catch missing pkgs ---"; \
       } \
    && if [ -n "$BIOC_PKGS" ]; then \
       echo "--- Installing Bioconductor packages (ANCOMBC, MSstats, MSstatsTMT, DEP excluded) ---"; \
       { R -e "\
         .libPaths(c('${INFLEXA_LIB_ROOT}/r/bioconductor', '${INFLEXA_LIB_ROOT}/r/cran', .libPaths())); \
         if (!requireNamespace('BiocManager', quietly=TRUE)) install.packages('BiocManager', lib='${INFLEXA_LIB_ROOT}/r/cran', repos='https://cloud.r-project.org/'); \
         BiocManager::install(c($BIOC_PKGS), lib='${INFLEXA_LIB_ROOT}/r/bioconductor', ask=FALSE, update=FALSE, force=TRUE, Ncpus=${R_NCPUS:-parallel::detectCores()})" 2>&1 \
         | tee /tmp/bioc-install.log \
         | grep --line-buffered -vE "$NOISE"; } || true; \
       echo "--- Installing ANCOMBC from r-universe (Bioc 3.22's 2.12.0 uses CVXR::solve which was removed in CVXR 1.8; r-universe serves patched 2.12.1) ---"; \
       retry_install "ANCOMBC (r-universe)" /tmp/bioc-ancombc.log R -e "\
         .libPaths(c('${INFLEXA_LIB_ROOT}/r/bioconductor', '${INFLEXA_LIB_ROOT}/r/cran', .libPaths())); \
         install.packages('ANCOMBC', lib='${INFLEXA_LIB_ROOT}/r/bioconductor', repos=c('https://bioc-release.r-universe.dev', BiocManager::repositories()))"; \
       echo "--- Installing DEP from frozen Bioc 3.22 source repo (DEP was dropped from Bioc 3.23; bioc-release.r-universe.dev rolled forward and no longer carries it) ---"; \
       retry_install "DEP (Bioc 3.22 frozen)" /tmp/bioc-dep.log R -e "\
         .libPaths(c('${INFLEXA_LIB_ROOT}/r/bioconductor', '${INFLEXA_LIB_ROOT}/r/cran', .libPaths())); \
         install.packages('DEP', lib='${INFLEXA_LIB_ROOT}/r/bioconductor', repos=c('https://bioconductor.org/packages/3.22/bioc', BiocManager::repositories()), dependencies=TRUE)"; \
       echo "--- Installing MSstats/MSstatsTMT (C++14 override for RcppArmadillo ≥14.2) ---"; \
       mkdir -p ~/.R && echo 'CXX11STD = -std=gnu++14' > ~/.R/Makevars; \
       retry_install "MSstats/MSstatsTMT" /tmp/bioc-msstats.log R -e "\
         .libPaths(c('${INFLEXA_LIB_ROOT}/r/bioconductor', '${INFLEXA_LIB_ROOT}/r/cran', .libPaths())); \
         BiocManager::install(c('MSstats','MSstatsTMT'), lib='${INFLEXA_LIB_ROOT}/r/bioconductor', ask=FALSE, update=FALSE, force=TRUE, Ncpus=${R_NCPUS:-parallel::detectCores()})"; \
       rm -f ~/.R/Makevars; \
    fi \
    && echo "--- Capturing any bspm-apt-installed deps into the store bioconductor subtree ---" \
    && cp -an /usr/lib/R/site-library/. ${INFLEXA_LIB_ROOT}/r/bioconductor/ 2>/dev/null || true

# Best-effort load check → ${INFLEXA_LIB_ROOT}/bioconductor.packages.txt. On any
# floor breach the shared script prints per-package DROP diagnostics; the full
# install log remains at /tmp/bioc-install.log for the failure tail-dump.
RUN BIOC_PKGS=$(python3 -c "\
import yaml; \
m = yaml.safe_load(open('/tmp/manifest.yaml')); \
print('\n'.join(m.get('r',{}).get('bioconductor',[])))" 2>/dev/null) \
    && { R_LIBS_SITE=${INFLEXA_LIB_ROOT}/r/bioconductor:${INFLEXA_LIB_ROOT}/r/cran Rscript /usr/local/bin/lib-store-loadtest.R \
           "R (Bioconductor)" ${INFLEXA_LIB_ROOT}/bioconductor.packages.txt $BIOC_PKGS \
         || { echo "=== Error lines in /tmp/bioc-install.log ==="; \
              grep -n -B1 -A3 -E '^(ERROR:|Error:|installation of package .+ had non-zero|dependency .+ is not available)' /tmp/bioc-install.log 2>/dev/null || echo "(no explicit errors captured)"; \
              echo "=== Last 1000 lines of /tmp/bioc-install.log ==="; \
              tail -n 1000 /tmp/bioc-install.log 2>/dev/null || true; \
              exit 1; }; }

# =============================================================================
# Stage: github — R packages from GitHub (depends on CRAN + Bioconductor).
# =============================================================================
# Auth is required at scale: anonymous api.github.com is 60 req/hr per IP, and
# `remotes::install_github` with dependencies=TRUE burns several calls per repo.
# CI mounts the GHA-issued GITHUB_TOKEN as a BuildKit secret (1k req/hr per repo),
# which `remotes` picks up via the GITHUB_PAT env var. `required=false` keeps the
# stage runnable locally without a token (with the anonymous limit caveat).
FROM bioconductor AS github
ARG INFLEXA_LIB_ROOT

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
             .libPaths(c('${INFLEXA_LIB_ROOT}/r/github', '${INFLEXA_LIB_ROOT}/r/bioconductor', '${INFLEXA_LIB_ROOT}/r/cran', .libPaths())); \
             remotes::install_github('$repo', lib='${INFLEXA_LIB_ROOT}/r/github', dependencies=TRUE, upgrade='never')" 2>&1 \
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

# Best-effort load check → ${INFLEXA_LIB_ROOT}/github.packages.txt. library()
# every package actually installed into the github libdir (its directory names
# are the real package names — repo basenames diverge, e.g. stuart-lab/signac ->
# Signac, mojaveazure/seurat-disk -> SeuratDisk).
RUN GH_PKGS=$(ls ${INFLEXA_LIB_ROOT}/r/github 2>/dev/null | tr '\n' ' ') \
    && R_LIBS_SITE=${INFLEXA_LIB_ROOT}/r/github:${INFLEXA_LIB_ROOT}/r/bioconductor:${INFLEXA_LIB_ROOT}/r/cran \
         Rscript /usr/local/bin/lib-store-loadtest.R \
           "R (GitHub)" ${INFLEXA_LIB_ROOT}/github.packages.txt $GH_PKGS

# World-readable for the unprivileged sandbox user, matching the managed
# read-only mount. This MUST happen here, in the last builder stage to touch the
# r/ subtree, and never after the COPY in a shipped stage: chmod is a write, so
# it copies up every file it walks — even ones whose mode does not change — and
# the shipped layer then carries a second copy of the whole subtree. The COPY
# below preserves these modes, so the runtime needs no chmod of its own.
RUN chmod -R a+rX ${INFLEXA_LIB_ROOT}

# =============================================================================
# Stage: runtime — the lean published image. FROM sandbox-python; COPY the built
# r/ subtree + fragments in and regenerate packages.txt. No R build toolchain
# reaches this layer; the resolver env (R_LIBS_SITE, R_LIBS_USER) is already
# baked into sandbox-python and inherited here.
# =============================================================================
FROM ${SANDBOX_PYTHON_IMAGE} AS runtime
ARG INFLEXA_LIB_ROOT

# OCI metadata: link the package to its source repo and describe this layer.
LABEL org.opencontainers.image.source="https://github.com/inflexa-ai/inflexa"
LABEL org.opencontainers.image.description="Inflexa sandbox with the full baked library store — Python + R 4.6 (CRAN, Bioconductor, GitHub) + Node — at /mnt/libs/current; the complete OSS/managed sandbox image."

USER root

COPY --from=github ${INFLEXA_LIB_ROOT}/r ${INFLEXA_LIB_ROOT}/r
COPY --from=github ${INFLEXA_LIB_ROOT}/cran.packages.txt ${INFLEXA_LIB_ROOT}/cran.packages.txt
COPY --from=github ${INFLEXA_LIB_ROOT}/bioconductor.packages.txt ${INFLEXA_LIB_ROOT}/bioconductor.packages.txt
COPY --from=github ${INFLEXA_LIB_ROOT}/github.packages.txt ${INFLEXA_LIB_ROOT}/github.packages.txt

# Rebuild packages.txt from all six fragments (python/conda/node inherited from
# sandbox-python plus the three R fragments just copied), load-tested set only.
# No chmod here: every subtree is already world-readable from the builder stage
# that produced it, and re-walking the store with chmod would copy up the whole
# thing into this layer (see the note in the github stage).
RUN INFLEXA_LIB_ROOT=${INFLEXA_LIB_ROOT} inflexa-libs-refresh --from-fragments

USER sandbox
WORKDIR /workspace

CMD ["sandbox-server"]
