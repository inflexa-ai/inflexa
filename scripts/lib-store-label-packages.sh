#!/usr/bin/env bash
# Stamp an image's own package inventory onto it as an OCI label.
#
# `packages.txt` is produced INSIDE the build (inflexa-libs-refresh --from-fragments)
# and lists what actually passed the load check — not what the manifest requested. A
# host that never bind-mounts the library store has no other way to read it: the file
# exists only in the image, so a host-side read finds nothing and every agent is told
# the inventory is unknown.
#
# A label is the cheapest carrier that travels WITH the image and is per-arch for
# free — the pulled image is the host's arch, so its label is the right list by
# construction. Reading it is `docker inspect` on an already-pulled image: no
# container is created and no registry client is needed.
#
# LABEL cannot read a file at build time, so this is a label-only rebuild: a one-line
# `FROM <image>` with `--label`, which adds no filesystem layer and re-tags in place.
#
# Usage: lib-store-label-packages.sh <image-tag> <YYYYMMDD-abcdef0> <source-revision>
set -euo pipefail

IMAGE="${1:?usage: lib-store-label-packages.sh <image-tag> <version> <revision>}"
VERSION="${2:?usage: lib-store-label-packages.sh <image-tag> <version> <revision>}"
REVISION="${3:?usage: lib-store-label-packages.sh <image-tag> <version> <revision>}"
LABEL_KEY="ai.inflexa.lib-store.packages"
VERSION_LABEL="org.opencontainers.image.version"
REVISION_LABEL="org.opencontainers.image.revision"
PACKAGES_PATH="/mnt/libs/current/packages.txt"

if [[ ! "$VERSION" =~ ^[0-9]{8}-[0-9a-f]{7}$ ]]; then
    echo "::error::invalid sandbox image version '$VERSION' (expected YYYYMMDD-7hex)" >&2
    exit 1
fi

if [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::invalid sandbox source revision '$REVISION' (expected 40 lowercase hex characters)" >&2
    exit 1
fi

# Read the baked inventory out of the image. CI may run the image freely — the
# no-execution constraint applies to user machines, which read the label instead.
if ! PACKAGES="$(docker run --rm --entrypoint cat "$IMAGE" "$PACKAGES_PATH" 2>/dev/null)"; then
    echo "::error::$IMAGE has no $PACKAGES_PATH — the library-store build did not bake an inventory" >&2
    exit 1
fi

if [ -z "${PACKAGES//[[:space:]]/}" ]; then
    echo "::error::$IMAGE has an empty $PACKAGES_PATH — refusing to stamp a label that would read as 'no packages'" >&2
    exit 1
fi

# A store that loaded zero packages in every track is a build failure wearing a
# valid-looking file: the headings are present and every list under them is empty.
if ! printf '%s' "$PACKAGES" | grep -qE '^[^#[:space:]]'; then
    echo "::error::$IMAGE inventory has section headings but no package names" >&2
    exit 1
fi

echo "Stamping $(printf '%s' "$PACKAGES" | grep -cE '^[^#[:space:]]') inventory line(s) onto $IMAGE"

# `--label` carries the inventory through argv, so newlines and quotes need no escaping.
printf 'FROM %s\n' "$IMAGE" | docker buildx build --load -f - \
    --label "${LABEL_KEY}=${PACKAGES}" \
    --label "${VERSION_LABEL}=${VERSION}" \
    --label "${REVISION_LABEL}=${REVISION}" \
    -t "$IMAGE" .

# Fail publication at the stamping seam rather than shipping an image the CLI
# cannot turn into a stable execution reference.
test "$(docker image inspect --format "{{index .Config.Labels \"${VERSION_LABEL}\"}}" "$IMAGE")" = "$VERSION"
test "$(docker image inspect --format "{{index .Config.Labels \"${REVISION_LABEL}\"}}" "$IMAGE")" = "$REVISION"
