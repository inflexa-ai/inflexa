#!/usr/bin/env bash
# Build ONE library-store track in CI: run the track's Docker stage, then
# extract its subtree and packages.txt fragment into ./staging so
# lib-store-pack.sh can tarball it. Gate 1 (the fail-loud build-time load test)
# runs inside the Docker stage — a load failure fails this script.
#
# Usage: lib-store-build-track.sh <cran|bioconductor|github|python|conda|node>
# Env:   DOCKERFILE CONTEXT BASE_IMAGE PLATFORM BUILDER_NAME
#        GITHUB_TOKEN (github track only — forwarded as a build secret)

set -euo pipefail

TRACK="${1:?usage: lib-store-build-track.sh <track>}"
: "${DOCKERFILE:?}" "${CONTEXT:?}" "${BASE_IMAGE:?}" "${PLATFORM:?}" "${BUILDER_NAME:?}"

# shellcheck source=scripts/lib-store-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-store-common.sh"

# Track -> Docker build stage. The conda track's stage installs into the image's
# /mnt/libs/current (it validates against the mounted-path layout); every other
# stage stages under /staging.
case "$TRACK" in
  cran)         TARGET=cran;         SRC="/staging/r/cran";        FRAG="/staging/cran.packages.txt" ;;
  bioconductor) TARGET=bioconductor; SRC="/staging/r/bioconductor"; FRAG="/staging/bioconductor.packages.txt" ;;
  github)       TARGET=github;       SRC="/staging/r/github";      FRAG="/staging/github.packages.txt" ;;
  python)       TARGET=python;       SRC="/staging/python";        FRAG="/staging/python.packages.txt" ;;
  conda)        TARGET=system-tools; SRC="/mnt/libs/current/conda"; FRAG="/mnt/libs/current/conda.packages.txt" ;;
  node)         TARGET=node;         SRC="/staging/node";          FRAG="/staging/node.packages.txt" ;;
  *) echo "ERROR: unknown track: $TRACK" >&2; exit 1 ;;
esac

IMAGE="lib-store-$TRACK"
SECRET_ARGS=()
if [ "$TRACK" = github ] && [ -n "${GITHUB_TOKEN:-}" ]; then
  SECRET_ARGS=(--secret "id=github_token,env=GITHUB_TOKEN")
fi

docker buildx build \
  --file "$DOCKERFILE" \
  --build-arg "BASE_IMAGE=$BASE_IMAGE" \
  --platform "$PLATFORM" \
  --target "$TARGET" \
  --builder "$BUILDER_NAME" \
  "${SECRET_ARGS[@]}" \
  --load -t "$IMAGE" "$CONTEXT"

DEST="staging/$(lib_store_track_dir "$TRACK")"
mkdir -p "$DEST"
# --ignore-failed-read: `-h` dereferences symlinks so the store is self-contained
# (conda relies on this to inline its package-cache symlinks), but some Debian-packaged
# R deps (e.g. r-cran-jquerylib) symlink bundled JS to system libjs-* packages absent
# from the build image — dangling targets tar can't read. Skip those unreadable files
# instead of failing the whole track (they are already broken symlinks either way).
docker run --rm "$IMAGE" tar -chf - --ignore-failed-read -C "$SRC" . | tar -xf - -C "$DEST"
docker run --rm "$IMAGE" cat "$FRAG" > "staging/$(lib_store_track_fragment "$TRACK")"

echo "$TRACK: $(find "$DEST" -maxdepth 1 -mindepth 1 | wc -l) top-level entries"
