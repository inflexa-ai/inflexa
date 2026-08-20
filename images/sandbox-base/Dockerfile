# Inflexa Sandbox - the one runtime image
#
# The image owns each language interpreter, the system libraries, and each track a
# package farm cannot carry. The store owns the packages. Thus the R library and
# the Python library come from the shared package store, mounted read-only at
# /mnt/libs, and NO library is baked here.
#
# The conda prefix and the Node packages are the two tracks a farm cannot carry,
# thus the image carries them. Both live OUTSIDE the store mount — at /opt/conda
# and /opt/node — because a store mounts over /mnt/libs and would shadow any path
# baked below it.
#
# Size: ~2.3GB on arm64 before the conda and Node tracks, of which the chromium
#       layer is a measured 477MB (see that section for why the browser is here).
# Contains: R 4.6.0, Python 3.12, Node.js 20, runtime system libs, fonts, tools,
#           chromium (plotly static image export via kaleido), the bioconda
#           command-line tools at /opt/conda, the Node packages at /opt/node,
#           sandbox-server (Go static binary for HTTP-based command execution)
#
# Build context is the repo ROOT (so COPY can reach images/package-store/manifest.yaml).

# Must match the manifest base_image (images/package-store/manifest.yaml). CI passes --build-arg.
ARG BASE_IMAGE=rocker/r-ver:4.6.0@sha256:6f05a1a8b8c52328f181593923909b01cbfd14c9caea93bf75ddc65e806d8eac

# Target arch (auto-set by buildx). It arch-gates the numba target of the runtime.
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
# Stage 3: libs-toolchain — the manifest and the tool that reads it. The conda
# builder and the node builder both branch from it.
# =============================================================================

FROM ${BASE_IMAGE} AS libs-toolchain

# A failed producer in a pipeline must fail the layer.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# python3 reads the manifest and python3-yaml parses it. The conda track and the
# Node track install prebuilt artifacts, thus this stage needs no compiler and no
# -dev header.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-yaml curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY images/package-store/manifest.yaml /tmp/manifest.yaml

# =============================================================================
# Stage 4: conda-builder — the bioinformatics command-line tools, from bioconda.
#
# The prefix is MADE at /opt/conda, the path it is read at. conda writes the
# absolute prefix path into each shebang and each RPATH, thus a prefix that is
# built elsewhere and then copied, linked, or moved does not run. The COPY in the
# runtime stage below lands it at the same /opt/conda.
# =============================================================================

FROM libs-toolchain AS conda-builder
ARG TARGETARCH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# micromamba (deterministic binary from the official image).
COPY --from=mambaorg/micromamba:2.5.0 /bin/micromamba /usr/local/bin/micromamba

# `common + <arch>` — the manifest decides the arch split (amd64-only tools have
# no linux-aarch64 bioconda build). Strict channel priority prevents mixed
# conda-forge/bioconda dependency conflicts.
RUN TOOLS=$(python3 -c "\
import yaml, os; \
g = yaml.safe_load(open('/tmp/manifest.yaml'))['system_tools']; \
print(' '.join(g['common'] + g.get(os.environ.get('TARGETARCH', 'amd64'), [])))" 2>/dev/null || true) \
    && if [ -n "$TOOLS" ]; then \
       micromamba create -y -p /opt/conda \
         --channel-priority strict \
         -c conda-forge -c bioconda \
         $TOOLS; \
       micromamba clean --all --yes; \
    fi

# Best-effort load check — every manifest tool that resolves on PATH goes into the
# fragment (a canned --version call is logged for visibility); a missing tool is
# dropped. Floor: zero resolved tools fails the build. PATH carries the conda bin
# so a tool that ships its own runtime can find it — appended AFTER the system
# dirs so the `python3` below stays the system one, which carries pyyaml.
#
# What is probed is the BINARY, which the manifest entry only usually names: an
# entry can carry a conda version pin (`samtools=1.22.1`) and a package can
# install an executable under another name (`eagle2` -> `eagle`, through the
# manifest's `binaries` map). A probe of the raw entry would drop a tool that
# works.
#
# The load check writes the fragment to /tmp, and the runtime stage copies it into
# the baked image inventory at /opt/inflexa. That path sits outside the store mount,
# thus the image advertises its own command-line tools and a mounted store never
# shadows the record. The floor is the other reason for this check, and the floor
# fails the build when zero tools resolve.
ENV PATH="${PATH}:/opt/conda/bin"
RUN TOOLS=$(python3 -c "\
import yaml, os, re; \
g = yaml.safe_load(open('/tmp/manifest.yaml'))['system_tools']; \
b = g.get('binaries') or {}; \
specs = g['common'] + g.get(os.environ.get('TARGETARCH', 'amd64'), []); \
names = [re.split(r'[=<>!~\s]', s.strip(), maxsplit=1)[0] for s in specs]; \
print('\n'.join(b.get(n, n) for n in names))" 2>/dev/null) \
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

# World-readable for the unprivileged sandbox user. The chmod MUST stay in this
# builder stage: chmod is a write, so it copies up every file it walks — even one
# whose mode does not change — and a shipped layer would then carry a second copy
# of the whole prefix. The COPY below preserves these modes.
RUN chmod -R a+rX /opt/conda

# =============================================================================
# Stage 5: node-builder — the Node packages, at /opt/node.
#
# npm hoists one flat node_modules tree, which does not divide into one directory
# for each package. A Python distribution and an R package do divide that way,
# thus the farm code of the provisioner has no counterpart here and the image owns
# this track.
# =============================================================================

FROM libs-toolchain AS node-builder

# `npm install | tail` must preserve npm's failure status.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# TODO(supply-chain): this pipes NodeSource's setup script straight into bash, so
# its contents are fetched and executed unpinned — the same gap the runtime stage
# below records.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# The node package set is the manifest's flat `node:` list.
RUN mkdir -p /opt/node \
    && NODE_PKGS=$(python3 -c "\
import yaml; \
print(' '.join(yaml.safe_load(open('/tmp/manifest.yaml'))['node']))" 2>/dev/null || true) \
    && cd /opt/node && npm install $NODE_PKGS 2>&1 | tail -3

# Best-effort load check — require() each manifest node package; the fragment
# comes from the set that loaded; floor if zero. (/opt/node carries the manifest's
# direct deps; their transitive deps live under node_modules but are not
# advertised.) The runtime stage copies the fragment into the baked image inventory
# at /opt/inflexa, the same as the conda fragment.
RUN NODE_PKGS=$(python3 -c "\
import yaml; \
print(' '.join(yaml.safe_load(open('/tmp/manifest.yaml'))['node']))" 2>/dev/null) \
    && cd /opt/node \
    && FRAG="/tmp/node.packages.txt" NODE_PKGS="$NODE_PKGS" node -e '\
const pkgs = (process.env.NODE_PKGS || "").split(/\s+/).filter(Boolean); \
const bad = []; \
for (const p of pkgs) { \
  try { require(p); console.log("  OK: " + p); } \
  catch (e) { console.log("DROP " + p + ": " + e.message); bad.push(p); } \
} \
const ok = pkgs.filter((p) => !bad.includes(p)); \
require("fs").writeFileSync(process.env.FRAG, "## Node (npm)\n" + ok.join(", ") + "\n"); \
if (bad.length) console.error("NOTE: " + bad.length + " Node package(s) dropped"); \
if (!ok.length) { console.error("ERROR: the node track loaded ZERO packages (non-empty floor)"); process.exit(1); } \
console.log("Load check OK: " + ok.length + "/" + pkgs.length + " Node package(s) loaded");'

# World-readable — see the note above the matching chmod in conda-builder.
RUN chmod -R a+rX /opt/node

# =============================================================================
# Stage 6: Runtime image
# =============================================================================

FROM ${BASE_IMAGE} AS runtime

# A failed producer in a pipeline must fail the layer, not be hidden by a
# successful shell/checksum/filter command on the right-hand side.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# OCI metadata: link the published package to its source repo (so GHCR files it
# under the repo and it inherits repo access) and give it a specific description.
LABEL org.opencontainers.image.source="https://github.com/inflexa-ai/inflexa"
LABEL org.opencontainers.image.description="Inflexa sandbox runtime — rocker/r-ver, system Python 3.12, Node.js 20, the bioconda command-line tools at /opt/conda, the Node packages at /opt/node, the sandbox server, and the provenance hooks. It bakes no R library and no Python library: the package store, mounted read-only at /mnt/libs, is the one source of a library."

# =============================================================================
# Runtime system libraries (no -dev packages, no build toolchain)
# =============================================================================

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Python 3.12 (libpython3.12 needed by packages like pyBigWig that link against it)
    python3 python3-pip python3-venv libpython3.12 \
    # Compression / archive
    libbz2-1.0 liblzma5 zlib1g libzstd1 \
    pigz parallel p7zip-full \
    # SSL / networking / XML
    libffi8 libssl3t64 libxml2 libcurl4 libgit2-1.7 \
    # Async event loop (r-cran-fs → libuv, pulls in usethis/devtools/…) + protobuf
    # (r-cran-otelsdk OTLP export). r2u links these against the system libs, so the
    # runtime must ship them or fs/otelsdk fail dyn.load and cascade to their dependents.
    libuv1t64 libprotobuf32t64 \
    # HDF5 / array / scientific IO / linear programming
    libhdf5-103-1t64 libnetcdf19t64 libopenblas0 liblapack3 libfftw3-double3 \
    libglpk40 \
    # Geospatial / spatial omics
    libgdal34t64 libgeos3.12.1t64 libproj25 libsqlite3-0 libudunits2-0 \
    libtiff6 libjpeg-turbo8 libpng16-16 libgl1 libglib2.0-0 \
    # OpenGL utility library (libGLU.so.1), for rgl. rgl is a transitive dependency
    # of the R pak solve, thus nothing in the manifest promises it. rgl links against
    # libGLU at dyn.load. The base image has libGL (libgl1) but not libGLU, thus rgl
    # fails to load without this package.
    libglu1-mesa \
    # Graphics / rendering / fonts
    libcairo2 libfreetype6 libfontconfig1 libharfbuzz0b libfribidi0 \
    libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 \
    libmagick++-6.q16-9t64 libgsl27 libgslcblas0 \
    # Bayesian inference (required by infercnv for posterior CNV calls)
    jags \
    # MILP solver, as /usr/bin/cbc. CARNIVAL and cosmosR both fall back to
    # lpSolve, which they carry as a hard dependency and which their own
    # documentation calls a testing-only solver that "does not scale well with
    # large PKNs" — against cosmosR's shipped 117k-interaction network it does
    # not close. Without a real solver those two are installed rather than
    # usable. Both take a solver by explicit path, so the skill layer has to
    # pass /usr/bin/cbc; nothing discovers it.
    coinor-cbc \
    # Java. NOTHING IN THE IMAGE CURRENTLY USES IT — no Java tool is in the
    # manifest, so this is ~150 MB carried for a consumer that has not landed
    # yet. It is kept because PharmCAT is the intended one and its reference
    # genome is already catalogued; drop this the moment that stops being true.
    default-jre-headless \
    # Shell utilities. `gpg` is not in the base image (only `gpgv`, which apt uses
    # to verify signatures but cannot dearmor a key); the chromium section below
    # needs the full tool to convert the PPA's armored key into a keyring.
    curl ca-certificates git wget unzip file tree bsdmainutils jq gpg \
    # Egress firewall for Docker poll mode: the root entrypoint installs
    # `iptables -P OUTPUT DROP` before dropping to the workload uid. `setpriv`
    # (util-linux) performs that de-privileged exec. iptables is inert unless
    # SANDBOX_EGRESS_FIREWALL=1 is set (callback mode and K8s never set it).
    iptables \
    && rm -rf /var/lib/apt/lists/*

# rgl draws with OpenGL, but the runtime is headless and has no display. This env
# selects the rgl null device. Thus rgl loads and draws to an off-screen buffer, and
# rgl.init does not open a GLX context. Without it, rgl.init fails on a machine with
# no X server, even when libGLU is present.
ENV RGL_USE_NULL=TRUE

# =============================================================================
# Node.js 20
# =============================================================================

# TODO(supply-chain): this pipes NodeSource's setup script straight into bash, so
# its contents are fetched and executed unpinned. A streamed script can't be
# `sha256sum -c`-verified; hardening means installing the NodeSource apt key and
# repo line by hand (or a pinned nodejs .deb verified by digest) instead of `| bash`.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Python tools (uv + ruff)
# =============================================================================

ENV UV_VERSION=0.7.12
ENV RUFF_VERSION=0.16.0
# TODO(supply-chain): `| sh` runs Astral's installer before anything can verify it.
# UV_VERSION pins which uv is installed, but the install.sh itself is fetched
# unpinned; hardening means downloading the versioned uv tarball and checking it
# against Astral's published sha256 before running, not piping to sh.
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv \
    && cp /root/.local/bin/uvx /usr/local/bin/uvx \
    && uv pip install --system --break-system-packages --no-cache "ruff==${RUFF_VERSION}"

# =============================================================================
# Tailwind CSS standalone CLI
# =============================================================================

ENV TAILWINDCSS_VERSION=v4.1.4
ARG TARGETARCH
# SHA-256 sums from the v4.1.4 release's published sha256sums.txt; verifying the
# fetched binary closes the supply-chain gap of trusting a bare HTTPS download.
RUN TW_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "linux-arm64" || echo "linux-x64") \
    && TW_SHA=$([ "$TARGETARCH" = "arm64" ] \
         && echo "a14537ef51a99c1a55c3764b73b81681d84ff75197ad766f9a6628d610cf274f" \
         || echo "0fa8bbb8beca7242f6455bf01bbe35d3083878f6308ec4a4cec30aed16bca46d") \
    && curl -sSL -o /usr/local/bin/tailwindcss \
       "https://github.com/tailwindlabs/tailwindcss/releases/download/${TAILWINDCSS_VERSION}/tailwindcss-${TW_ARCH}" \
    && echo "${TW_SHA}  /usr/local/bin/tailwindcss" | sha256sum -c - \
    && chmod +x /usr/local/bin/tailwindcss

# =============================================================================
# Fonts — Inter and JetBrains Mono (OFL licensed)
# =============================================================================

# TODO(supply-chain): pin these zips by SHA-256. Neither the rsms/inter v4.0 nor
# the JetBrains/JetBrainsMono v2.304 GitHub release ships a checksums file, so
# there is no upstream digest to `sha256sum -c` against — adding one would mean
# trusting a locally computed hash (TOFU), not verified provenance.
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
# Chromium — the rendering engine behind plotly static image export (kaleido)
# =============================================================================

# kaleido <1.0 shipped its own patched Chromium inside the wheel. 1.0 dropped it:
# the wheel is now a thin CDP client (choreographer) that drives a browser found
# on the host, so an unpinned `kaleido` in the package-store manifest resolves to 1.x
# and every fig.write_image() fails with ChromeNotFoundError unless a browser is
# staged here. This is the same rule that puts `jags` in this file for r-cran-rjags:
# a manifest package's RUNTIME system dependency belongs in the base image.
#
# The browser belongs to the image and never to the store. kaleido arrives with
# the mounted store, and a store carries packages only, thus a browser staged
# anywhere but here would leave each sandbox with kaleido and nothing to render
# with.
#
# Why the xtradeb PPA and not something more obvious:
#   - Ubuntu noble has no real chromium deb. `chromium`/`chromium-browser` in the
#     archive is a transitional stub that PreDepends on snapd and installs a snap —
#     inert in a container.
#   - Chrome for Testing (what kaleido's own `kaleido_get_chrome` fetches) publishes
#     linux64 only. This image is published for amd64 AND arm64, so it cannot serve
#     both.
#   - Debian's chromium builds against Debian-versioned libs (libjpeg62-turbo,
#     libflac12, libxnvctrl0) that do not resolve on noble.
# xtradeb builds chromium natively for noble on both arches, and it is an apt source:
# signed, with a per-deb SHA-256 in the index, which is stronger provenance than the
# unsigned CDN zips the alternatives would have meant.
#
# COST, deliberately taken: chromium and its dependency closure are a measured 477MB
# in one layer, on an image the README treats as lean for managed cold-start reasons.
# Static image export for reports was judged worth it; if that trade is ever
# revisited, this block and the BROWSER_PATH below are the whole change to undo.
#
# The key is pinned by full fingerprint and re-verified after import, so a wrong or
# substituted keyserver response fails the build rather than silently trusting a key.
#
# The PPA is added, used, and then REMOVED in this same layer. Leaving a
# single-maintainer third-party apt source enabled inside the containment boundary
# would widen the trusted set for every later apt operation in this image and in any
# `FROM` extension of it, and nothing after this needs it — the binary is installed.
# (Consequence, accepted: chromium does not move on `apt-get upgrade` downstream. It
# moves when this image is rebuilt, which is how every other pin here behaves.)
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

# choreographer resolves the browser as `os.environ.get("BROWSER_PATH", <PATH search>)`.
# The PATH search already finds /usr/bin/chromium, but it walks chrome -> chromium ->
# edge -> brave -> vivaldi and takes the first hit, so it is order-dependent on what
# else a downstream `FROM` image installs. Setting it explicitly pins the answer.
ENV BROWSER_PATH=/usr/bin/chromium

# =============================================================================
# Runtime setup
# =============================================================================

RUN ln -s /usr/bin/python3 /usr/local/bin/python

# .pth file so system Python 3.12 discovers the farm packages without
# PYTHONPATH (which would leak into conda's Python 3.11 and break ABI). The
# farm of an analysis mounts at /mnt/libs/farm.
RUN echo "/mnt/libs/farm/python/site-packages" > /usr/lib/python3/dist-packages/inflexa-libs.pth

# =============================================================================
# The package store — the mount points and the resolver env. The image bakes
# NO library: the store mount point stays empty, so a bind of the store lands
# on a path that exists. The farm of an analysis mounts at /mnt/libs/farm, and
# the optional read-write cache at /mnt/libs/cache. The cache mount point is
# NOT baked: the seed of the entrypoint detects the cache by its presence.
# =============================================================================

RUN mkdir -p /mnt/libs/farm/python/site-packages

# Self-sufficiency: a plain `docker run` with a store mounted and NO harness
# resolves an import through this env. The harness injects the same values when it
# mounts the store, thus the baked env is redundant with it and never in conflict.
#
# PATH puts /opt/conda/bin LAST, so the system python3 — which reads the store
# .pth — stays the default `python3`, and not conda's own Python, which cannot see
# the site-packages of the store.
#
# NODE_PATH and PATH name a path in this image, never a path under /mnt/libs. A
# store mounts read-only over /mnt/libs, thus a store-relative value here would
# remove the command-line tools of the image from each sandbox that has a store.
ENV R_LIBS_SITE="/mnt/libs/farm/r/github:/mnt/libs/farm/r/bioconductor:/mnt/libs/farm/r/cran"
ENV NODE_PATH="/opt/node/node_modules"
# The farm python/bin comes LAST, after the conda bin — the same order the
# harness mount plan emits — thus a farm script never shadows an image tool.
ENV PATH="${PATH}:/opt/conda/bin:/mnt/libs/farm/python/bin"

# The two tracks a package farm cannot carry. Both paths sit outside /mnt/libs,
# thus a mounted store shadows neither. The conda prefix was made at /opt/conda
# and it lands at /opt/conda, because its shebangs and its RPATHs carry that
# absolute path.
COPY --from=conda-builder /opt/conda /opt/conda
COPY --from=node-builder /opt/node /opt/node

# The image advertises its own two tracks — the bioconda command-line tools and the
# Node packages — through a baked inventory fragment. Each builder derived its
# fragment from the set that its load check resolved, thus the record matches what
# the image installed and it cannot drift. The fragment lands at /opt/inflexa,
# outside the store mount, thus a mounted store never shadows it. The harness tool
# list_available_packages merges this fragment with the farm inventory, so an agent
# reads one complete package list.
COPY --from=conda-builder /tmp/conda.packages.txt /opt/inflexa/conda.packages.txt
COPY --from=node-builder /tmp/node.packages.txt /opt/inflexa/node.packages.txt
RUN cat /opt/inflexa/conda.packages.txt /opt/inflexa/node.packages.txt \
      > /opt/inflexa/image-packages.txt \
    && chmod -R a+rX /opt/inflexa

# No library-specific reference paths are baked in. The reference store is
# optional, its layout is owned by the catalog (and versioned per dataset), and
# a path compiled into the image would either point at nothing or pin the image
# to one catalog version. Agents call `list-available-refs`, get absolute paths
# back, and pass them explicitly — the same contract Azimuth already required
# via Azimuth::LoadReference(). A library that insists on an env var (CellTypist
# reads $CELLTYPIST_FOLDER) can have one exported per-command, by the agent that
# just learned the real path.

RUN useradd -l -m -u 1000 -s /bin/bash sandbox \
    && mkdir -p /workspace && chown -R sandbox:sandbox /workspace

# Declared explicitly rather than left to the runtime's passwd lookup, which
# resolves against the *create-time* user: poll mode creates the container as
# root (for CAP_NET_ADMIN) and reaches uid 1000 only via the entrypoint's
# `setpriv`, which changes credentials but not environment; K8s creates it with a
# numeric `runAsUser` and no lookup at all. Neither yields a home for the uid the
# workload actually runs as.
#
# This path must also stay writable: numba resolves a cache locator per
# @njit(cache=True) function and raises when none is writable, and with the lib
# store read-only `$HOME/.cache/numba` is the last candidate.
ENV HOME=/home/sandbox

# sandbox-server binary — copied last so Go code changes don't invalidate
# the expensive apt/font layers above.
COPY --from=server-builder /sandbox-server /usr/local/bin/sandbox-server

# Entrypoint wrapper: installs the poll-mode egress firewall (as root, when
# SANDBOX_EGRESS_FIREWALL=1) then drops to the workload uid, else execs the
# server directly.
COPY images/sandbox-base/sandbox-entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
RUN chmod +x /usr/local/bin/sandbox-entrypoint.sh

# The seed of the prepared caches. The entrypoint sources it, and so does the cache
# effectiveness check, which runs its own program in place of the server. One file
# thus serves both, and the check exercises the code that a sandbox runs. It is
# sourced and never executed, thus it takes no execute bit.
COPY images/sandbox-base/inflexa-seed-caches /usr/local/bin/inflexa-seed-caches

# Provenance tracking hooks
COPY --from=provtrack-builder /provtrack.so /opt/provenance/provtrack.so
COPY images/sandbox-base/provenance/sitecustomize.py /opt/provenance/sitecustomize.py
COPY images/sandbox-base/provenance/Rprofile.site /opt/provenance/Rprofile.site

# Default to the unprivileged workload user. Callback mode and K8s run as uid
# 1000 throughout. Docker poll mode overrides `User` to root at create time so
# the entrypoint can install the egress firewall, then `setpriv` drops back to
# uid 1000 before the server starts.
WORKDIR /workspace
USER sandbox

EXPOSE 8765

ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint.sh"]

# =============================================================================
# Stage 7: the arch-gated numba target
# =============================================================================
# On arm64 the numba/LLVM CPU target is pinned to a generic model. An autodetect
# of the host CPU crashes LLVM codegen on a newer arm64 core, and a generic target
# is portable across each arm64 CPU. The provisioner sets the identical value when
# it warms the JIT cache of a farm (`warm()` in provision.py), thus a mismatch here
# would make each cache entry miss. amd64 keeps the host autodetect.
#
# Both stages derive from the one runtime stage, and only the stage of the target
# arch is built, thus this costs no repeated work.
FROM runtime AS runtime-amd64
FROM runtime AS runtime-arm64
ENV NUMBA_CPU_NAME=generic
FROM runtime-${TARGETARCH}
