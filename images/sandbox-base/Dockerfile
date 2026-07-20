# Inflexa Sandbox - Base Image
# Single image for all sandbox pods. R, Python, and Node packages come
# from the shared library store mounted at /mnt/libs (not baked in).
#
# Size target: 800MB-1.2GB
# Contains: R 4.6.0, Python 3.12, Node.js 20, runtime system libs, fonts, tools,
#           sandbox-server (Go static binary for HTTP-based command execution)

# Must match lib-store-manifest.yaml base_image. CI passes --build-arg.
ARG BASE_IMAGE=rocker/r-ver:4.6.0@sha256:6f05a1a8b8c52328f181593923909b01cbfd14c9caea93bf75ddc65e806d8eac

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
# Stage 3: Runtime image
# =============================================================================

FROM ${BASE_IMAGE}

# OCI metadata: link the published package to its source repo (so GHCR files it
# under the repo and it inherits repo access) and give it a specific description.
LABEL org.opencontainers.image.source="https://github.com/inflexa-ai/inflexa"
LABEL org.opencontainers.image.description="Inflexa sandbox base — minimal runtime (rocker/r-ver + system Python 3.12) with the sandbox server and provenance hooks; the layer sandbox-python and sandbox-python-r build on."

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
    # Graphics / rendering / fonts
    libcairo2 libfreetype6 libfontconfig1 libharfbuzz0b libfribidi0 \
    libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 \
    libmagick++-6.q16-9t64 libgsl27 libgslcblas0 \
    # Bayesian inference (required by infercnv for posterior CNV calls)
    jags \
    # Java (for FastQC and other Java-based tools)
    default-jre-headless \
    # Shell utilities
    curl ca-certificates git wget unzip file tree bsdmainutils jq \
    # Egress firewall for Docker poll mode: the root entrypoint installs
    # `iptables -P OUTPUT DROP` before dropping to the workload uid. `setpriv`
    # (util-linux) performs that de-privileged exec. iptables is inert unless
    # SANDBOX_EGRESS_FIREWALL=1 is set (callback mode and K8s never set it).
    iptables \
    && rm -rf /var/lib/apt/lists/*

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
# TODO(supply-chain): `| sh` runs Astral's installer before anything can verify it.
# UV_VERSION pins which uv is installed, but the install.sh itself is fetched
# unpinned; hardening means downloading the versioned uv tarball and checking it
# against Astral's published sha256 before running, not piping to sh.
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv \
    && cp /root/.local/bin/uvx /usr/local/bin/uvx \
    && uv pip install --system --break-system-packages --no-cache ruff

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
# Runtime setup
# =============================================================================

RUN ln -s /usr/bin/python3 /usr/local/bin/python

# .pth file so system Python 3.12 discovers the lib store packages without
# PYTHONPATH (which would leak into conda's Python 3.11 and break ABI).
RUN echo "/mnt/libs/current/python/site-packages" > /usr/lib/python3/dist-packages/inflexa-libs.pth

# No library-specific reference paths are baked in. The reference store is
# optional, its layout is owned by the catalog (and versioned per dataset), and
# a path compiled into the image would either point at nothing or pin the image
# to one catalog version. Agents call `list-available-refs`, get absolute paths
# back, and pass them explicitly — the same contract Azimuth already required
# via Azimuth::LoadReference(). A library that insists on an env var (CellTypist
# reads $CELLTYPIST_FOLDER) can have one exported per-command, by the agent that
# just learned the real path.

RUN useradd -m -u 1000 -s /bin/bash sandbox \
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
