#!/usr/bin/env bash
# Extract the per-track library-store subtrees + packages.txt fragments OUT of a
# published sandbox image into a staging tree, so lib-store-pack.sh can tarball
# them for the managed mount. The tarballs are therefore a BYPRODUCT of the same
# images the OSS user runs — one build, two consumers.
#
# Extracts whichever tracks the image actually carries: pass the highest image
# that built for the arch (sandbox-python-r when R built, else sandbox-python) and
# every present /mnt/libs/current/<track> subtree is extracted; absent tracks are
# skipped, so an arm64 image without R simply yields the non-R tracks.
#
# Usage: lib-store-extract-tarballs.sh <image_ref> <staging_dir>
# Env:   PLATFORM  optional docker --platform (default: the image's own)

set -euo pipefail

IMAGE="${1:?usage: lib-store-extract-tarballs.sh <image_ref> <staging_dir>}"
STAGING="${2:?usage: lib-store-extract-tarballs.sh <image_ref> <staging_dir>}"

# shellcheck source=scripts/lib-store-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-store-common.sh"

PLATFORM_ARGS=()
[ -n "${PLATFORM:-}" ] && PLATFORM_ARGS=(--platform "$PLATFORM")

# The sandbox image runs as a non-root user (uid 1000). Extraction runs as root so
# it can drop the root-owned dangling symlinks below and read every track file.
DOCKER_RUN=(docker run --rm --user 0:0 "${PLATFORM_ARGS[@]}")

ROOT="$LIB_STORE_ROOT"
extracted=""

for track in $LIB_STORE_ALL_TRACKS; do
  subtree="$(lib_store_track_dir "$track")"           # e.g. r/cran, python, conda, node
  frag="$(lib_store_track_fragment "$track")"          # e.g. cran.packages.txt
  src="$ROOT/$subtree"
  dest="$STAGING/$subtree"

  # Present iff the subtree directory exists in the image.
  if ! "${DOCKER_RUN[@]}" "$IMAGE" test -d "$src" 2>/dev/null; then
    echo "skip $track: $src not present in $IMAGE"
    continue
  fi

  mkdir -p "$dest"
  # `-h` dereferences symlinks so the store is self-contained (conda relies on
  # this to inline its package-cache symlinks). Some Debian-packaged R deps
  # symlink bundled JS to system libjs-* packages absent from the image; with -h
  # those dangling links make GNU tar exit 1 and, under pipefail, sink the track.
  # Drop them first (as root — they're root-owned) so tar -h exits clean.
  "${DOCKER_RUN[@]}" "$IMAGE" \
    sh -c 'find "$1" -xtype l -delete; exec tar -chf - -C "$1" .' _ "$src" \
    | tar -xf - -C "$dest"
  "${DOCKER_RUN[@]}" "$IMAGE" cat "$ROOT/$frag" > "$STAGING/$frag"

  echo "extracted $track: $(find "$dest" -maxdepth 1 -mindepth 1 | wc -l | tr -d ' ') top-level entries"
  extracted="$extracted $track"
done

if [ -z "$extracted" ]; then
  echo "ERROR: no library-store tracks found in $IMAGE" >&2
  exit 1
fi
echo "Extracted tracks:$extracted"
