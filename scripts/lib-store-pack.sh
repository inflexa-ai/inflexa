#!/usr/bin/env bash
# Pack a staging tree into one content-addressed tarball per track.
#
# For each track whose subtree AND packages.txt fragment are present in the
# staging dir, emit <out>/<track>.tar.zst plus its sha256 and byte size (what the
# manifest pins). Tracks that did not build are skipped, so a partial build packs
# whatever succeeded. Writes <out>/tracks.txt listing the packed tracks, and
# <out>/packages.txt assembled from their fragments.
#
# This is the whole-tree packer, for the local/offline path — it holds every
# tarball at once. CI packs through lib-store-publish.sh, which streams one track
# at a time to hold the disk peak down.
#
# Usage: lib-store-pack.sh <staging_dir> <out_dir> [zstd_level]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-store-common.sh
source "$SCRIPT_DIR/lib-store-common.sh"

STAGING="${1:?usage: lib-store-pack.sh <staging_dir> <out_dir> [zstd_level]}"
OUT="${2:?usage: lib-store-pack.sh <staging_dir> <out_dir> [zstd_level]}"
ZSTD_LEVEL="${3:-$LIB_STORE_ZSTD_LEVEL}"

[ -d "$STAGING" ] || { echo "ERROR: staging dir not found: $STAGING" >&2; exit 1; }
mkdir -p "$OUT"

packed=""
for track in $LIB_STORE_ALL_TRACKS; do
  if lib_store_track_staged "$STAGING" "$track"; then
    lib_store_pack_track "$STAGING" "$OUT" "$track" "$ZSTD_LEVEL"
    echo "packed $track -> $OUT/$track.tar.zst ($(du -h "$OUT/$track.tar.zst" | cut -f1), sha256 $(cut -c1-12 "$OUT/$track.tar.zst.sha256")…)"
    packed="$packed $track"
  fi
done

if [ -z "$packed" ]; then
  echo "ERROR: no complete tracks (subtree + fragment) found in $STAGING" >&2
  exit 1
fi

# shellcheck disable=SC2086 # packed is an intentional word list, one per line
printf '%s\n' $packed > "$OUT/tracks.txt"

# The assembled packages.txt spans tracks, so no per-track tarball can carry it.
# It travels beside them as its own object.
"$SCRIPT_DIR/lib-store-write-packages.sh" "$STAGING" "$packed" > "$OUT/packages.txt"

echo "Packed tracks:$packed"
echo "assembled $OUT/packages.txt ($(wc -l < "$OUT/packages.txt" | tr -d ' ') lines)"
