# Inflexa Sandbox — the one runtime image.
#
# The image owns each language interpreter, the system libraries, and the two
# tracks that a package farm cannot carry. The store owns the packages. The
# store mounts read-only at /mnt/libs, and the image bakes NO library.
#
# The conda prefix and the Node packages are the two image-owned tracks. Both
# live outside the store mount, at /opt/conda and /opt/node, because a store
# mounts over /mnt/libs and hides each baked path below it.
#
# Size: ~2.3GB on arm64 before the conda track and the Node track. The
#       chromium layer is a measured 477MB (that section gives the reason).
# Contains: R 4.6.0, Python 3.12, Node.js 24, the runtime system libraries,
#           fonts, tools, chromium (static plotly export through kaleido),
#           the bioconda command-line tools at /opt/conda, the Node packages
#           at /opt/node, and sandbox-server (a static Go binary for HTTP
#           command execution).
#
# The build context is the repo ROOT. Thus COPY reaches
# images/package-store/manifest.yaml.

# The value must match the manifest base_image
# (images/package-store/manifest.yaml). CI passes --build-arg.
ARG BASE_IMAGE=rocker/r-ver:4.6.0@sha256:6f05a1a8b8c52328f181593923909b01cbfd14c9caea93bf75ddc65e806d8eac

# The target arch. buildx sets it, and it gates the numba target of the runtime.
ARG TARGETARCH

# =============================================================================
# Stage 1: Build sandbox-server (Go static binary)
# =============================================================================

FROM golang:1.26-bookworm@sha256:e60d708a92ad26a6d61901334510d3debd23ddcba125663ecd6008d42e8ec669 AS server-builder

WORKDIR /build
COPY images/sandbox-base/server/go.mod images/sandbox-base/server/go.sum ./
RUN go mod download
COPY images/sandbox-base/server/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /sandbox-server .

# =============================================================================
# Stage 2: Build provenance LD_PRELOAD library
# =============================================================================

FROM gcc:bookworm@sha256:9ca91b05c7b07d2979f16413e8b2cd6ec8a7c80ffca4121ccab0aeba33f90460 AS provtrack-builder

COPY images/sandbox-base/provenance/provtrack.c /build/provtrack.c
RUN gcc -shared -fPIC -O2 -pthread -fstack-protector-strong -Wformat -Wformat-security -o /provtrack.so /build/provtrack.c -ldl

# =============================================================================
# Stage 3: libs-toolchain — the manifest and the reader scripts. The conda
# builder and the node builder both branch from this stage.
# =============================================================================

FROM ${BASE_IMAGE} AS libs-toolchain

# A failed producer in a pipeline must fail the layer.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# python3 runs the reader scripts, and python3-yaml parses the manifest. The
# conda track and the Node track install prebuilt artifacts. Thus this stage
# needs no compiler and no -dev header.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-yaml curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY images/package-store/manifest.yaml /tmp/manifest.yaml
COPY images/sandbox-base/scripts/ /tmp/scripts/

# =============================================================================
# Stage 4: conda-builder — the bioinformatics command-line tools, from bioconda.
#
# The build makes the prefix at /opt/conda, and the runtime reads it there.
# conda writes the absolute prefix path into each shebang and each RPATH.
# Thus a prefix that moves after the build does not run. The COPY in the
# runtime stage lands it at the same /opt/conda.
# =============================================================================

FROM libs-toolchain AS conda-builder
ARG TARGETARCH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# micromamba, a deterministic binary from the official image.
COPY --from=mambaorg/micromamba:2.9.0 /bin/micromamba /usr/local/bin/micromamba

# The tool set is `common` plus the arch list of the manifest. An amd64-only
# tool has no linux-aarch64 bioconda build. Strict channel priority prevents
# a mixed conda-forge/bioconda dependency conflict.
RUN TOOLS=$(python3 /tmp/scripts/conda-tools.py 2>/dev/null || true) \
    && if [ -n "$TOOLS" ]; then \
       micromamba create -y -p /opt/conda \
         --channel-priority strict \
         -c conda-forge -c bioconda \
         $TOOLS; \
       micromamba clean --all --yes; \
    fi

# The load check of the conda track. Each manifest tool that resolves on PATH
# goes into the inventory fragment, and a missing tool drops with a log line.
# The floor: zero resolved tools fail the build. PATH gains the conda bin.
# Thus a tool that ships its own runtime finds it. The conda bin comes AFTER
# the system dirs, thus `python3` stays the system one, which carries pyyaml.
#
# The probe reads the BINARY name that conda-binaries.py prints, not the raw
# manifest entry. A probe of the raw entry drops a tool that works (refer to
# the docstring of that script).
#
# The check writes the fragment to /tmp, and the runtime stage copies it to
# /opt/inflexa. That path sits outside the store mount. Thus the image
# advertises its own tools, and a mounted store never shadows the record.
ENV PATH="${PATH}:/opt/conda/bin"
RUN TOOLS=$(python3 /tmp/scripts/conda-binaries.py 2>/dev/null) \
    && ok=""; failed=""; \
    for tool in $TOOLS; do \
      if command -v "$tool" >/dev/null 2>&1; then \
        ver=$("$tool" --version 2>&1 | head -1 || true); \
        echo "  OK: $tool ${ver}"; ok="$ok $tool"; \
      else \
        echo "DROP: $tool not found on PATH"; failed="$failed $tool"; \
      fi; \
    done; \
    printf '## System tools (CLI)\n%s\n' "$(printf '%s\n' $ok | sort | paste -sd, - | sed 's/,/, /g')" \
      > /tmp/conda.packages.txt; \
    [ -n "$failed" ] && echo "NOTE: system tool(s) dropped:$failed"; \
    if [ -z "$(printf '%s' $ok)" ]; then echo "ERROR: the conda track resolved ZERO tools (non-empty floor) — failing the build."; exit 1; fi; \
    echo "Load check OK: system tools resolved"

# World-readable for the unprivileged sandbox user. The chmod MUST stay in
# this builder stage. chmod is a write, thus it copies up each file that it
# walks, even one whose mode does not change. In a shipped layer, that write
# makes a second copy of the whole prefix. The COPY below keeps these modes.
RUN chmod -R a+rX /opt/conda

# =============================================================================
# Stage 5: node-builder — the Node packages, at /opt/node.
#
# npm hoists one flat node_modules tree, and that tree does not divide into
# one directory per package. A Python distribution and an R package divide
# that way. Thus the farm code of the provisioner has no counterpart here,
# and the image owns this track.
# =============================================================================

FROM libs-toolchain AS node-builder

# `npm install | tail` must keep the failure status of npm.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# TODO(supply-chain): this pipes the NodeSource setup script into bash, thus
# the script runs unpinned. The runtime stage records the same gap.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# The node package set is the flat `node:` list of the manifest.
RUN mkdir -p /opt/node \
    && NODE_PKGS=$(python3 /tmp/scripts/node-packages.py 2>/dev/null || true) \
    && cd /opt/node && npm install $NODE_PKGS 2>&1 | tail -3

# The load check of the node track (refer to node-load-check.js). The
# fragment holds the set that loaded, and zero loaded packages fail the
# build. /opt/node carries the direct dependencies of the manifest. Their
# transitive dependencies live under node_modules, but the fragment does not
# advertise them. The runtime stage copies the fragment to /opt/inflexa, the
# same as the conda fragment.
RUN NODE_PKGS=$(python3 /tmp/scripts/node-packages.py 2>/dev/null) \
    && cd /opt/node \
    && FRAG="/tmp/node.packages.txt" NODE_PKGS="$NODE_PKGS" node /tmp/scripts/node-load-check.js

# World-readable — refer to the note above the matching chmod in conda-builder.
RUN chmod -R a+rX /opt/node

# =============================================================================
# Stage 6: Runtime image
# =============================================================================

FROM ${BASE_IMAGE} AS runtime

# A failed producer in a pipeline must fail the layer. A successful command
# on the right-hand side must not hide it.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# OCI metadata. The source label links the published package to the repo.
# GHCR then files the package under the repo, and the package inherits the
# repo access. The description names the content.
LABEL org.opencontainers.image.source="https://github.com/inflexa-ai/inflexa"
LABEL org.opencontainers.image.description="Inflexa sandbox runtime — rocker/r-ver, system Python 3.12, Node.js 24, the bioconda command-line tools at /opt/conda, the Node packages at /opt/node, the sandbox server, and the provenance hooks. It bakes no R library and no Python library: the package store, mounted read-only at /mnt/libs, is the one source of a library."

# =============================================================================
# Runtime system libraries (no -dev packages, no build toolchain)
# =============================================================================

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Python 3.12. libpython3.12 backs a package that links against it, for
    # example pyBigWig.
    python3 python3-pip python3-venv libpython3.12 \
    # Compression / archive
    libbz2-1.0 liblzma5 zlib1g libzstd1 \
    pigz parallel p7zip-full \
    # SSL / networking / XML
    libffi8 libssl3t64 libxml2 libcurl4 libgit2-1.7 \
    # libuv backs r-cran-fs, and libprotobuf backs the OTLP export of
    # r-cran-otelsdk. r2u links both against the system libraries. Thus the
    # runtime must ship them, or fs and otelsdk fail at dyn.load, and the
    # failure cascades to each dependent (usethis, devtools, and more).
    libuv1t64 libprotobuf32t64 \
    # HDF5 / array / scientific IO / linear programming
    libhdf5-103-1t64 libnetcdf19t64 libopenblas0 liblapack3 libfftw3-double3 \
    libglpk40 \
    # Geospatial / spatial omics
    libgdal34t64 libgeos3.12.1t64 libproj25 libsqlite3-0 libudunits2-0 \
    libtiff6 libjpeg-turbo8 libpng16-16 libgl1 libglib2.0-0 \
    # The OpenGL utility library (libGLU.so.1), for rgl. rgl is a transitive
    # dependency of the R pak solve, thus no manifest entry promises it. rgl
    # links against libGLU at dyn.load. The base image has libgl1 and no
    # libGLU, thus rgl fails to load without this package.
    libglu1-mesa \
    # Graphics / rendering / fonts
    libcairo2 libfreetype6 libfontconfig1 libharfbuzz0b libfribidi0 \
    libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 \
    libmagick++-6.q16-9t64 libgsl27 libgslcblas0 \
    # Bayesian inference. infercnv uses it for posterior CNV calls.
    jags \
    # A MILP solver, as /usr/bin/cbc. CARNIVAL and cosmosR fall back to
    # lpSolve, a hard dependency of both. Their own documentation calls
    # lpSolve a testing-only solver that does not scale. Against the shipped
    # 117k-interaction network of cosmosR, it does not close. Without a real
    # solver, the two install but do not work. Both take a solver by an
    # explicit path. Thus the skill layer must pass /usr/bin/cbc, because
    # nothing discovers it.
    coinor-cbc \
    # Java. NOTHING IN THE IMAGE USES IT TODAY. No Java tool is in the
    # manifest, thus this is ~150 MB for a consumer that did not land yet.
    # PharmCAT is the intended consumer, and its reference genome is already
    # catalogued. Drop this when that intent dies.
    default-jre-headless \
    # Shell utilities. The base image has only gpgv, which cannot dearmor a
    # key. The chromium section below converts an armored PPA key into a
    # keyring, thus it needs the full gpg tool.
    curl ca-certificates git wget unzip file tree bsdmainutils jq gpg \
    # The egress firewall of the Docker poll mode. The root entrypoint
    # installs `iptables -P OUTPUT DROP`, and `setpriv` (util-linux) then
    # drops to the workload uid. iptables stays inert unless
    # SANDBOX_EGRESS_FIREWALL=1 is set. Callback mode and K8s never set it.
    iptables \
    && rm -rf /var/lib/apt/lists/*

# rgl draws with OpenGL, but the runtime is headless and has no display. This
# env selects the rgl null device. Thus rgl loads and draws to an off-screen
# buffer, and rgl.init does not open a GLX context. Without it, rgl.init
# fails on a machine with no X server, even when libGLU is present.
ENV RGL_USE_NULL=TRUE

# =============================================================================
# Node.js 24
# =============================================================================

# TODO(supply-chain): this pipes the NodeSource setup script into bash, thus
# the script runs unpinned. A streamed script cannot pass a `sha256sum -c`
# comparison. The hard fix: install the NodeSource apt key and the repo line
# by hand, or a pinned nodejs .deb with a digest, in place of `| bash`.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Python tools (uv + ruff)
# =============================================================================

ENV UV_VERSION=0.12.5
ENV RUFF_VERSION=0.16.3
# TODO(supply-chain): `| sh` runs the Astral installer before any control
# sees it. UV_VERSION pins which uv installs, but the install.sh itself
# arrives unpinned. The hard fix: download the versioned uv tarball, compare
# it against the published sha256 of Astral, and then run it.
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv \
    && cp /root/.local/bin/uvx /usr/local/bin/uvx \
    && uv pip install --system --break-system-packages --no-cache "ruff==${RUFF_VERSION}"

# =============================================================================
# Tailwind CSS standalone CLI
# =============================================================================

ENV TAILWINDCSS_VERSION=v4.3.3
ARG TARGETARCH
# The SHA-256 sums come from the published sha256sums.txt of the release. The
# comparison of the fetched binary closes the supply-chain gap of a bare
# HTTPS download.
RUN TW_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "linux-arm64" || echo "linux-x64") \
    && TW_SHA=$([ "$TARGETARCH" = "arm64" ] \
         && echo "55fd0b241214eff3de1e8ee4f22796662f2d2e7a49bcfca7477cfd0bac398195" \
         || echo "dc61b3ac6b8c9ca874c0cc4c57b2409791a64c5540404ca5f5367360babc313a") \
    && curl -sSL -o /usr/local/bin/tailwindcss \
       "https://github.com/tailwindlabs/tailwindcss/releases/download/${TAILWINDCSS_VERSION}/tailwindcss-${TW_ARCH}" \
    && echo "${TW_SHA}  /usr/local/bin/tailwindcss" | sha256sum -c - \
    && chmod +x /usr/local/bin/tailwindcss

# =============================================================================
# Fonts — Inter and JetBrains Mono (OFL licensed)
# =============================================================================

# TODO(supply-chain): pin these zips by SHA-256. The rsms/inter v4.0 release
# and the JetBrains/JetBrainsMono v2.304 release ship no checksums file. Thus
# no upstream digest exists, and a locally computed hash gives trust on first
# use, not provenance.
RUN mkdir -p /usr/local/share/fonts \
    && curl -sSL -o /tmp/inter.zip \
       "https://github.com/rsms/inter/releases/download/v4.0/Inter-4.0.zip" \
    && unzip -q /tmp/inter.zip -d /tmp/inter \
    && find /tmp/inter -name "*.ttf" -exec cp {} /usr/local/share/fonts/ \; \
    && rm -rf /tmp/inter /tmp/inter.zip \
    && curl -sSL -o /tmp/jetbrains.zip \
       "https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip" \
    && unzip -q /tmp/jetbrains.zip -d /tmp/jetbrains \
    && cp /tmp/jetbrains/fonts/ttf/*.ttf /usr/local/share/fonts/ \
    && rm -rf /tmp/jetbrains /tmp/jetbrains.zip \
    && fc-cache -fv

# =============================================================================
# Chromium — the rendering engine behind static plotly export (kaleido)
# =============================================================================

# kaleido <1.0 shipped its own patched Chromium inside the wheel. 1.0 dropped
# it: the wheel is now a thin CDP client (choreographer) that drives a
# browser of the host. Thus an unpinned `kaleido` in the manifest resolves to
# 1.x, and each fig.write_image() fails with ChromeNotFoundError without a
# browser here. The rule is the same one that puts `jags` in this file for
# r-cran-rjags: a runtime system dependency of a manifest package belongs in
# the base image.
#
# The browser belongs to the image, never to the store. kaleido arrives with
# the mounted store, and a store carries packages only. Thus a browser staged
# anywhere else leaves each sandbox with kaleido and nothing that renders.
#
# Why the xtradeb PPA:
#   - Ubuntu noble has no real chromium deb. The archive package is a
#     transitional stub that installs a snap, and a snap is inert in a
#     container.
#   - Chrome for Testing, the browser that kaleido fetches itself, publishes
#     linux64 only. This image publishes for amd64 AND arm64.
#   - The Debian chromium builds against Debian-versioned libraries
#     (libjpeg62-turbo, libflac12, libxnvctrl0) that do not resolve on noble.
# xtradeb builds chromium for noble on both arches, and it is an apt source:
# signed, with a per-deb SHA-256 in the index. That provenance is stronger
# than the unsigned CDN zips of the alternatives.
#
# COST, taken on purpose: chromium and its dependency closure measure 477MB
# in one layer, on an image that stays lean for managed cold starts. Static
# image export for reports won that trade. To undo it, remove this block and
# the BROWSER_PATH below — that is the whole change.
#
# The key is pinned by its full fingerprint, and the comparison runs again
# after the import. Thus a wrong keyserver response fails the build, and the
# build does not trust a substituted key.
#
# The layer adds the PPA, uses it, and then REMOVES it. A third-party apt
# source with one maintainer must not stay enabled inside the containment
# boundary. Enabled, it widens the trusted set of each later apt operation,
# here and in each FROM extension, and nothing after this needs it. Accepted
# consequence: chromium does not move on a downstream `apt-get upgrade`. It
# moves when this image rebuilds, the same as each other pin here.
ARG CHROMIUM_PPA_FINGERPRINT=5301FA4FD93244FBC6F6149982BB6851C64F6880
RUN curl -fsSL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x${CHROMIUM_PPA_FINGERPRINT}" \
      | gpg --dearmor -o /usr/share/keyrings/xtradeb-apps.gpg \
    && gpg --show-keys --with-colons --fingerprint /usr/share/keyrings/xtradeb-apps.gpg \
      | awk -F: '/^fpr:/{print $10}' | grep -qx "${CHROMIUM_PPA_FINGERPRINT}" \
    && echo "deb [signed-by=/usr/share/keyrings/xtradeb-apps.gpg] https://ppa.launchpadcontent.net/xtradeb/apps/ubuntu noble main" \
      > /etc/apt/sources.list.d/xtradeb-apps.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends chromium \
    && rm -f /etc/apt/sources.list.d/xtradeb-apps.list /usr/share/keyrings/xtradeb-apps.gpg \
    && rm -rf /var/lib/apt/lists/* \
    && chromium --version

# choreographer resolves the browser as BROWSER_PATH first, then a PATH walk.
# The walk tries chrome, chromium, edge, brave, and vivaldi, and it takes the
# first hit. Thus the answer depends on what a downstream FROM image adds.
# The explicit value pins the answer.
ENV BROWSER_PATH=/usr/bin/chromium

# =============================================================================
# Runtime setup
# =============================================================================

RUN ln -s /usr/bin/python3 /usr/local/bin/python

# A .pth file lets the system Python 3.12 discover the farm packages without
# PYTHONPATH. PYTHONPATH leaks into the Python 3.11 of conda and breaks its
# ABI. The farm of an analysis mounts at /mnt/libs/farm.
RUN echo "/mnt/libs/farm/python/site-packages" > /usr/lib/python3/dist-packages/inflexa-libs.pth

# =============================================================================
# The package store — the mount points and the resolver env. The image bakes
# NO library: the store mount point stays empty, so a bind of the store lands
# on a path that exists. The farm of an analysis mounts at /mnt/libs/farm,
# and the optional read-write cache at /mnt/libs/cache. The cache mount point
# is NOT baked: the seed of the entrypoint detects the cache by its presence.
# =============================================================================

RUN mkdir -p /mnt/libs/farm/python/site-packages

# Self-sufficiency: a plain `docker run` with a mounted store and NO harness
# resolves an import through this env. The harness injects the same values
# when it mounts the store. Thus the baked env is redundant with it, and the
# two never conflict.
#
# PATH puts /opt/conda/bin LAST. Thus the system python3, which reads the
# store .pth, stays the default `python3`. The conda Python cannot see the
# site-packages of the store.
#
# NODE_PATH and PATH name a path in this image, never a path under /mnt/libs.
# A store mounts read-only over /mnt/libs. Thus a store-relative value here
# removes the image tools from each sandbox that has a store.
ENV R_LIBS_SITE="/mnt/libs/farm/r/github:/mnt/libs/farm/r/bioconductor:/mnt/libs/farm/r/cran"
ENV NODE_PATH="/opt/node/node_modules"
# The farm python/bin comes LAST, after the conda bin — the same order that
# the harness mount plan emits. Thus a farm script never shadows an image
# tool.
ENV PATH="${PATH}:/opt/conda/bin:/mnt/libs/farm/python/bin"

# The two tracks that a package farm cannot carry. Both paths sit outside
# /mnt/libs, thus a mounted store shadows neither. The build made the conda
# prefix at /opt/conda, and it lands at /opt/conda, because its shebangs and
# its RPATHs carry that absolute path.
COPY --from=conda-builder /opt/conda /opt/conda
COPY --from=node-builder /opt/node /opt/node

# The image advertises its own two tracks through a baked inventory fragment.
# Each builder derived its fragment from the set that its load check
# resolved. Thus the record matches what the image installed, and it cannot
# drift. The fragment lands at /opt/inflexa, outside the store mount, thus a
# mounted store never shadows it. The harness tool list_available_packages
# merges this fragment with the farm inventory. Thus an agent reads one
# complete package list.
COPY --from=conda-builder /tmp/conda.packages.txt /opt/inflexa/conda.packages.txt
COPY --from=node-builder /tmp/node.packages.txt /opt/inflexa/node.packages.txt
RUN cat /opt/inflexa/conda.packages.txt /opt/inflexa/node.packages.txt \
      > /opt/inflexa/image-packages.txt \
    && chmod -R a+rX /opt/inflexa

# No library-specific reference path is baked in. The reference store is
# optional, and the catalog owns its layout, versioned per dataset. A path
# compiled into the image points at nothing, or it pins the image to one
# catalog version. An agent calls `list-available-refs`, gets absolute paths
# back, and passes them explicitly — the same contract that
# Azimuth::LoadReference() already required. A library that insists on an env
# var (CellTypist reads $CELLTYPIST_FOLDER) can get one per command, from the
# agent that just learned the real path.

RUN useradd -l -m -u 1000 -s /bin/bash sandbox \
    && mkdir -p /workspace && chown -R sandbox:sandbox /workspace

# Declared explicitly, not left to the passwd lookup of the runtime. That
# lookup resolves against the create-time user. Poll mode creates the
# container as root (for CAP_NET_ADMIN) and reaches uid 1000 only through
# the `setpriv` of the entrypoint, which changes credentials and not the
# environment. K8s creates it with a numeric runAsUser and no lookup at all.
# Neither path yields a home for the uid that runs the workload.
#
# This path must also stay writable. numba resolves a cache locator per
# @njit(cache=True) function, and it raises when none is writable. With a
# read-only store, `$HOME/.cache/numba` is the last candidate.
ENV HOME=/home/sandbox

# The sandbox-server binary — copied last. Thus a Go code change does not
# invalidate the expensive apt and font layers above.
COPY --from=server-builder /sandbox-server /usr/local/bin/sandbox-server

# The entrypoint wrapper. With SANDBOX_EGRESS_FIREWALL=1, it installs the
# poll-mode egress firewall as root and then drops to the workload uid. In
# each other case, it execs the server directly.
COPY images/sandbox-base/sandbox-entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
RUN chmod +x /usr/local/bin/sandbox-entrypoint.sh

# The seed of the prepared caches. The entrypoint sources it, and the cache
# check of the build sources the same file in place of the server. One file
# serves both, thus the check exercises the code that a sandbox runs. Each
# caller sources it and none executes it, thus it lives in lib, not in bin,
# and it takes no execute bit.
COPY images/sandbox-base/inflexa-seed-caches.sh /usr/local/lib/inflexa-seed-caches.sh

# Provenance tracking hooks
COPY --from=provtrack-builder /provtrack.so /opt/provenance/provtrack.so
COPY images/sandbox-base/provenance/sitecustomize.py /opt/provenance/sitecustomize.py
COPY images/sandbox-base/provenance/Rprofile.site /opt/provenance/Rprofile.site

# The default is the unprivileged workload user. Callback mode and K8s run as
# uid 1000 throughout. Docker poll mode overrides User to root at create
# time, thus the entrypoint can install the egress firewall. `setpriv` then
# drops back to uid 1000 before the server starts.
WORKDIR /workspace
USER sandbox

EXPOSE 8765

ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint.sh"]

# =============================================================================
# Stage 7: the arch-gated numba target
# =============================================================================
# On arm64 the numba/LLVM CPU target pins to a generic model. An autodetect
# of the host CPU crashes the LLVM code generator on a newer arm64 core, and
# a generic target is portable across each arm64 CPU. The provisioner sets
# the identical value when it warms the JIT cache of a farm (warm() in
# provision.py). A mismatch here makes each cache entry miss. amd64 keeps the
# host autodetect.
#
# Both stages derive from the one runtime stage, and only the stage of the
# target arch builds. Thus this costs no repeated work.
FROM runtime AS runtime-amd64
FROM runtime AS runtime-arm64
ENV NUMBA_CPU_NAME=generic
FROM runtime-${TARGETARCH}
