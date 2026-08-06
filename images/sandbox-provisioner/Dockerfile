# Provisioner — the container that HAS network and HAS compilers.
#
# It never sees user data: the only thing mounted into it is the package store.
# It exists to turn "I need scanpy" into files on disk, then dies. The sandbox
# that later runs analysis code has no network, drops all capabilities, and reads
# the same store read-only.
#
# BASE_IMAGE must be byte-identical to the one sandbox-base is built from.
# Everything the provisioner compiles is loaded later by the sandbox's system
# Python and R, so a different base means a different libc/libstdc++/Python ABI
# and .so files that import in here and fail out there. The digest is asserted
# against the manifest's base_image below, so a drift fails the build.
#
# Build context is the repo root, matching the other image Dockerfiles: the build
# reaches images/ for the shared toolchain, the packages.txt producer, and the
# manifest.
ARG BASE_IMAGE=rocker/r-ver:4.6.0@sha256:6f05a1a8b8c52328f181593923909b01cbfd14c9caea93bf75ddc65e806d8eac
FROM ${BASE_IMAGE}
# Re-declared after FROM so the assertion RUN can read it.
ARG BASE_IMAGE

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Assert the provisioner base equals the manifest's declared base_image — the
# single source of truth sandbox-base's own BASE_IMAGE mirrors. A mismatch here
# means the compiled extensions would target a different ABI than the sandbox
# loads them with, so fail the build rather than ship that drift.
COPY images/lib-store-manifest.yaml /tmp/lib-store-manifest.yaml
RUN declared="$(grep -E '^base_image:' /tmp/lib-store-manifest.yaml \
      | sed -E 's/^base_image:[[:space:]]*"?([^"]+)"?.*/\1/')" \
    && if [[ "$declared" != "$BASE_IMAGE" ]]; then \
         echo "provisioner base ($BASE_IMAGE) != manifest base_image ($declared)" >&2; \
         exit 1; \
       fi \
    && echo "base digest matches manifest: $declared" \
    && rm /tmp/lib-store-manifest.yaml

# The same toolchain the image builds use, from the same script, so a package
# that compiles during a CI image build also compiles during a user install.
# python3-yaml is the system-python YAML the manifest parse reads; the jags/libuv/
# libprotobuf/libglpk runtime .so set mirrors sandbox-base so R packages that
# dlopen them at library() time load in the provisioner too (pak installs most
# system libraries itself from each package's SystemRequirements).
COPY images/install-build-toolchain.sh /tmp/install-build-toolchain.sh
RUN bash /tmp/install-build-toolchain.sh python3-yaml jags libuv1t64 libprotobuf32t64 libglpk40

# Pinned to sandbox-base's uv so resolution and wheel selection are identical to
# what the baked images got.
ARG UV_VERSION=0.7.12
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv

# pak resolves and installs the R track (bulk CRAN + Bioconductor + git) from one
# lockfile, adding each package's system libraries itself. gen-r-lock.R is the same
# generator the baked image build uses, so the provisioner and the image resolve the
# R track identically against the base's pinned P3M snapshot.
RUN R -e "install.packages(c('pak', 'yaml'))" > /tmp/pak-bootstrap.log 2>&1 \
    || { cat /tmp/pak-bootstrap.log; exit 1; }
COPY images/gen-r-lock.R /usr/local/bin/gen-r-lock.R

# The same packages.txt producer the published images run, so a store assembled
# here and a store baked into an image advertise their contents identically.
COPY images/sandbox-python/inflexa-libs-refresh /usr/local/bin/inflexa-libs-refresh
COPY images/sandbox-provisioner/provision.py /usr/local/bin/provision
RUN chmod +x /usr/local/bin/inflexa-libs-refresh /usr/local/bin/provision

ENTRYPOINT ["/usr/local/bin/provision"]
