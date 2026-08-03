# Provisioner — the container that HAS network and HAS compilers.
#
# It never sees user data: the only things mounted into it are the package store
# and the farm directory. It exists to turn "I need scanpy" into files on disk,
# then dies.
#
# BASE_IMAGE must be byte-identical to the one sandbox-base is built from.
# Everything the provisioner compiles is loaded later by the sandbox's system
# Python and R, so a different base means a different libc/libstdc++/Python ABI
# and .so files that import in here and fail out there.
ARG BASE_IMAGE=rocker/r-ver:4.6.0@sha256:6f05a1a8b8c52328f181593923909b01cbfd14c9caea93bf75ddc65e806d8eac
FROM ${BASE_IMAGE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# The same toolchain the image builds use, from the same script, so a package
# that compiles during a CI image build also compiles during a user install.
COPY images/install-build-toolchain.sh /tmp/install-build-toolchain.sh
RUN bash /tmp/install-build-toolchain.sh python3-yaml

# Pinned to sandbox-base's uv so resolution and wheel selection are identical to
# what the baked images got.
ARG UV_VERSION=0.7.12
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv

# The same packages.txt producer the published images run, so a store assembled
# here and a store baked into an image advertise their contents identically.
COPY images/sandbox-python/inflexa-libs-refresh /usr/local/bin/inflexa-libs-refresh
COPY scripts/store-prototype/provision.py /usr/local/bin/provision
RUN chmod +x /usr/local/bin/inflexa-libs-refresh /usr/local/bin/provision

ENTRYPOINT ["/usr/local/bin/provision"]
