# Provisioner — the container that HAS network and HAS compilers.
#
# It never sees user data: the only thing mounted into it is the package store.
# It exists to turn "I need scanpy" into files on disk, then dies. The sandbox
# that later runs analysis code has no network, drops all capabilities, and
# reads the same store read-only.
#
# The privilege asymmetry between the two containers is deliberate and it is
# the security posture of the store: this image holds the compilers and an
# egress allowlist (refer to provisioner-entrypoint.sh); the runtime image
# holds neither. What this image writes, the runtime image only reads.
#
# BASE_IMAGE must be byte-identical to the one sandbox-base is built from.
# Everything the provisioner compiles is loaded later by the sandbox's system
# Python and R, so a different base means a different libc/libstdc++/Python ABI
# and .so files that import in here and fail out there. The digest is asserted
# against the manifest's base_image below, so a drift fails the build.
#
# Build context is the repo root, matching the other image Dockerfiles: the
# build reaches images/ for the shared toolchain and the manifest.
ARG BASE_IMAGE=rocker/r-ver:4.6.0@sha256:6f05a1a8b8c52328f181593923909b01cbfd14c9caea93bf75ddc65e806d8eac
FROM ${BASE_IMAGE}
# Re-declared after FROM so the assertion RUN can read it.
ARG BASE_IMAGE

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Assert the provisioner base equals the manifest's declared base_image — the
# single source of truth sandbox-base's own BASE_IMAGE mirrors. A mismatch here
# means the compiled extensions would target a different ABI than the sandbox
# loads them with, so fail the build rather than ship that drift.
COPY images/package-store/manifest.yaml /tmp/package-store-manifest.yaml
RUN declared="$(grep -E '^base_image:' /tmp/package-store-manifest.yaml \
      | sed -E 's/^base_image:[[:space:]]*"?([^"]+)"?.*/\1/')" \
    && if [[ "$declared" != "$BASE_IMAGE" ]]; then \
         echo "provisioner base ($BASE_IMAGE) != manifest base_image ($declared)" >&2; \
         exit 1; \
       fi \
    && echo "base digest matches manifest: $declared" \
    && rm /tmp/package-store-manifest.yaml

# The same toolchain the image builds use, from the same script, so a package
# that compiles during a CI catalog build also compiles during a user install.
# python3-yaml is the system-python YAML the manifest parse reads.
# python3-packaging is the reference reader of a PEP 508 marker, which
# emit_deps.py uses. Both are named here, thus neither can arrive as a
# transitive package that a later change removes. iptables backs the egress
# allowlist of the entrypoint.
# The jags/libuv/libprotobuf/libglpk runtime .so set mirrors sandbox-base so R
# packages that dlopen them at library() time load in the provisioner too (pak
# installs most system libraries itself from each package's SystemRequirements).
COPY images/install-build-toolchain.sh /tmp/install-build-toolchain.sh
RUN bash /tmp/install-build-toolchain.sh python3-yaml python3-packaging iptables jags libuv1t64 libprotobuf32t64 libglpk40

# Pinned to sandbox-base's uv so resolution and wheel selection are identical to
# what the runtime image environment expects.
ARG UV_VERSION=0.12.5
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv

# pak resolves and installs the R tracks. gen-r-lock.R is the bulk resolver of
# the catalog build, and acquire_r.R is the incremental resolver of one
# acquisition — both resolve against the base's pinned P3M snapshot. jsonlite
# backs the JSON of the acquire helper.
RUN R -e "install.packages(c('pak', 'yaml', 'jsonlite'))" > /tmp/pak-bootstrap.log 2>&1 \
    || { cat /tmp/pak-bootstrap.log; exit 1; }
COPY images/sandbox-provisioner/gen-r-lock.R /usr/local/bin/gen-r-lock.R
COPY images/sandbox-provisioner/acquire_r.R /usr/local/bin/acquire_r.R

# The provisioner program: five subcommands, one mode each. emit_deps.py rides
# beside it, because provision.py imports it and the directory of the running
# script is on the module path. base-packages.json holds the image-owned names
# that the emitter drops an edge into.
COPY images/sandbox-provisioner/provision.py /usr/local/bin/provision
COPY images/sandbox-provisioner/emit_deps.py /usr/local/bin/emit_deps.py
COPY images/sandbox-provisioner/base-packages.json /usr/local/bin/base-packages.json
COPY images/sandbox-provisioner/provisioner-entrypoint.sh /usr/local/bin/provisioner-entrypoint.sh
RUN chmod +x /usr/local/bin/provision /usr/local/bin/emit_deps.py \
      /usr/local/bin/provisioner-entrypoint.sh

# Attach the published package to the repo, the same as sandbox-base. GHCR reads
# this label to link the new package to the repository. A linked package takes
# the repository visibility. An unlinked package stays private.
LABEL org.opencontainers.image.source="https://github.com/inflexa-ai/inflexa"

ENTRYPOINT ["/usr/local/bin/provisioner-entrypoint.sh"]
