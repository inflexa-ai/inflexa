# syntax=docker/dockerfile:1
# sandbox-python-r — sandbox-python + the R libraries (CRAN, Bioconductor, git,
# GitHub). The R packages install into /mnt/libs/current/r/{cran,bioconductor,
# github} — the same subtree the managed mount populates — so a baked image and
# a mounted store present a byte-identical R library path.
#
# Multi-stage: a throwaway R builder resolves and installs the R libraries into the
# store; the final runtime stage is `FROM sandbox-python` and only COPYs the
# finished r/ subtree + fragments in, then regenerates packages.txt. No build
# toolchain reaches the runtime layer.
#
# The R libraries build in two units:
#   - the BULK — CRAN + Bioconductor + pinned git packages — resolves as one pak
#     lockfile and installs together. pak reads each package's SystemRequirements
#     and installs the missing apt libraries itself. The result is split into r/cran
#     and r/bioconductor by the CRAN-ref dependency closure — the same boundary the
#     previous two-stage (r2u then BiocManager) build produced. See images/gen-r-lock.R.
#   - GitHub installs incrementally on top of the bulk (remotes::install_github,
#     upgrade='never'), because the GitHub set does not resolve as one global lock:
#     it needs Remotes: following, and it pins recommended packages against the base.
#
# Reproducibility comes from the base image: rocker/r-ver:4.6.0 pins a dated P3M
# snapshot, so an in-build resolve returns the same versions on every build.
#
# Each unit runs a best-effort LOAD CHECK: library() each package, derive the
# fragment from what loaded, drop a single failure, fail the build only when a unit
# loaded ZERO packages (floor). The bulk and GitHub share one .libPaths(); a failed
# bulk aborts GitHub (and, on arm64 where source compiles are patchy, the whole arch
# build — best-effort per arch, handled by CI).
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
# Stage: r-toolchain — R build deps, the manifest, the load-check helper.
# =============================================================================
FROM ${BASE_IMAGE} AS r-toolchain
ARG INFLEXA_LIB_ROOT

# Build toolchain + dev headers for source compilation. The apt build-dep set +
# retry config is shared with sandbox-python; python3-yaml (the system-python YAML
# the manifest parse reads) installs in the same apt transaction as a stage-specific
# extra.
#
# The jags/libuv1t64/libprotobuf32t64/libglpk40 runtime .so set mirrors what
# sandbox-base ships, and exists here for the load checks below — which run in this
# builder, NOT in the runtime image. rjags/fs/otelsdk/igraph are binaries that
# dyn.load these at library() time, so omitting them makes the checks report a DROP
# (and omit the package from packages.txt) for packages that are in fact fine in the
# shipped image. Keep in sync with the runtime list in images/sandbox-base/Dockerfile:
# a lib there but missing here reappears as a phantom arch-specific coverage gap.
# pak installs most system libraries itself from each package's SystemRequirements;
# these are named explicitly so the load check stays honest even for a package that
# declares no requirement for the .so it dlopen()s.
COPY images/install-build-toolchain.sh /tmp/install-build-toolchain.sh
RUN bash /tmp/install-build-toolchain.sh python3-yaml jags libuv1t64 libprotobuf32t64 libglpk40

COPY images/lib-store-manifest.yaml /tmp/manifest.yaml

RUN mkdir -p ${INFLEXA_LIB_ROOT}/r/cran ${INFLEXA_LIB_ROOT}/r/bioconductor ${INFLEXA_LIB_ROOT}/r/github

# Injection guard (defense-in-depth). R names and git coordinates are interpolated
# into pak refs. Reject any value outside a safe shape once here (every stage
# branches from this one).
RUN python3 - <<'PYEOF'
import re, sys, yaml
m = yaml.safe_load(open("/tmp/manifest.yaml")) or {}
r = m.get("r", {}) or {}
name = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/@#-]*$")
url  = re.compile(r"^https://[A-Za-z0-9._/-]+$")
sha  = re.compile(r"^[0-9a-fA-F]{7,40}$")
bad = []
for grp in ("cran", "bioconductor", "github"):
    for n in (r.get(grp) or []):
        if not name.match(str(n)): bad.append(f"{grp}: {n!r}")
for g in (r.get("git") or []):
    if not name.match(str(g.get("name", ""))):  bad.append(f"git.name: {g.get('name')!r}")
    if not url.match(str(g.get("url", ""))):    bad.append(f"git.url: {g.get('url')!r}")
    if not sha.match(str(g.get("commit", ""))): bad.append(f"git.commit: {g.get('commit')!r}")
if bad:
    print("ERROR: manifest R entries outside the safe shape (pak-ref injection guard):", file=sys.stderr)
    for b in bad:
        print(f"  - {b}", file=sys.stderr)
    sys.exit(1)
print("manifest R injection guard: all cran/bioconductor/github/git entries within the safe shape")
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
# Stage: rlibs — the bulk (CRAN + Bioconductor + git) as one pak lockfile, split
# into r/cran and r/bioconductor by the CRAN-ref dependency closure.
#
# pak resolves against the base image's pinned P3M snapshot: CRAN and most
# Bioconductor packages arrive as binaries, the rest compile from source. The
# generator passes no repos= override — naming a repo drops rocker's HTTPUserAgent
# and forces ~300 source builds. pak installs each package's system libraries
# itself, so no arch-specific apt list is maintained here.
# =============================================================================
FROM r-toolchain AS rlibs
ARG INFLEXA_LIB_ROOT
ARG R_NCPUS

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY images/gen-r-lock.R /usr/local/bin/gen-r-lock.R

# Resolve + install the bulk and split it into r/cran and r/bioconductor. Output
# streams through an allow-based filter that drops gcc/boost compile noise (a
# full-bulk source build otherwise blows past GHA's 4MB per-step cap); the full log
# stays at /tmp/rlibs-install.log for the failure tail-dump. Install is best-effort
# and the load checks below are the gate — the same contract the old stages used.
RUN R -e "install.packages(c('pak', 'yaml'))" > /tmp/pak-bootstrap.log 2>&1 || { cat /tmp/pak-bootstrap.log; exit 1; } \
    && NOISE='/boost/|/Eigen/|/RcppEigen/|/RcppNumerical/|(required from|required by substitution|In instantiation of|skipping [0-9]+ instantiation)|^[^:]*:[0-9]+:[0-9]+: (warning|note):|^[[:space:]]+[0-9]+[[:space:]]+\||^[[:space:]]+\|[[:space:]]|OpenTelemetry error:' \
    && { R_NCPUS=${R_NCPUS} Rscript /usr/local/bin/gen-r-lock.R /tmp/manifest.yaml ${INFLEXA_LIB_ROOT} 2>&1 \
         | tee /tmp/rlibs-install.log | grep --line-buffered -vE "$NOISE"; } || true \
    && test "$(ls ${INFLEXA_LIB_ROOT}/r/cran 2>/dev/null | wc -l)" -gt 0 \
       || { echo "ERROR: gen-r-lock.R placed no CRAN packages"; tail -n 500 /tmp/rlibs-install.log 2>/dev/null; exit 1; }

# Best-effort load check → ${INFLEXA_LIB_ROOT}/cran.packages.txt (named CRAN
# packages, resolved against r/cran).
RUN CRAN_PKGS=$(python3 -c "\
import yaml; \
m = yaml.safe_load(open('/tmp/manifest.yaml')); \
print('\n'.join(m.get('r',{}).get('cran',[])))" 2>/dev/null) \
    && R_LIBS_SITE=${INFLEXA_LIB_ROOT}/r/cran Rscript /usr/local/bin/lib-store-loadtest.R \
         "R (CRAN)" ${INFLEXA_LIB_ROOT}/cran.packages.txt $CRAN_PKGS

# Best-effort load check → ${INFLEXA_LIB_ROOT}/bioconductor.packages.txt (named
# Bioconductor + git packages, resolved against r/bioconductor with r/cran on the
# path). The git packages (e.g. DEP) live here because gen-r-lock.R places any
# package outside the CRAN-ref closure into r/bioconductor.
RUN BIOC_PKGS=$(python3 -c "\
import yaml; \
m = yaml.safe_load(open('/tmp/manifest.yaml')); r = m.get('r',{}); \
names = list(r.get('bioconductor',[])) + [g['name'] for g in (r.get('git') or [])]; \
print('\n'.join(names))" 2>/dev/null) \
    && { R_LIBS_SITE=${INFLEXA_LIB_ROOT}/r/bioconductor:${INFLEXA_LIB_ROOT}/r/cran Rscript /usr/local/bin/lib-store-loadtest.R \
           "R (Bioconductor)" ${INFLEXA_LIB_ROOT}/bioconductor.packages.txt $BIOC_PKGS \
         || { echo "=== Last 1000 lines of /tmp/rlibs-install.log ==="; \
              tail -n 1000 /tmp/rlibs-install.log 2>/dev/null || true; \
              exit 1; }; }

# =============================================================================
# Stage: github — R packages from GitHub (depends on CRAN + Bioconductor).
# =============================================================================
# Auth is required at scale: anonymous api.github.com is 60 req/hr per IP, and
# `remotes::install_github` with dependencies=TRUE burns several calls per repo.
# CI mounts the GHA-issued GITHUB_TOKEN as a BuildKit secret (1k req/hr per repo),
# which `remotes` picks up via the GITHUB_PAT env var. `required=false` keeps the
# stage runnable locally without a token (with the anonymous limit caveat).
FROM rlibs AS github
ARG INFLEXA_LIB_ROOT

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

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
