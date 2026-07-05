#!/usr/bin/env bash
# Pack a staging tree into one content-addressed tarball per track.
#
# For each track whose subtree AND packages.txt fragment are present in the
# staging dir, emit <out>/<track>.tar.zst plus <out>/<track>.tar.zst.sha256
# (the digest the manifest pins). Tracks that did not build are skipped, so a
# partial build packs whatever succeeded. Writes <out>/tracks.txt listing the
# packed tracks.
#
# Usage: lib-store-pack.sh <staging_dir> <out_dir> [zstd_level]

set -euo pipefail

STAGING="${1:?usage: lib-store-pack.sh <staging_dir> <out_dir> [zstd_level]}"
OUT="${2:?usage: lib-store-pack.sh <staging_dir> <out_dir> [zstd_level]}"
ZSTD_LEVEL="${3:-3}"

# shellcheck source=scripts/lib-store-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-store-common.sh"

[ -d "$STAGING" ] || { echo "ERROR: staging dir not found: $STAGING" >&2; exit 1; }
mkdir -p "$OUT"

packed=""
for track in $LIB_STORE_ALL_TRACKS; do
  dir="$STAGING/$(lib_store_track_dir "$track")"
  frag="$STAGING/$(lib_store_track_fragment "$track")"
  if [ -d "$dir" ] && [ -f "$frag" ]; then
    members="$(lib_store_track_members "$track")"
    # shellcheck disable=SC2086 # members is an intentional word list
    tar -C "$STAGING" -cf - $members | zstd -q -f "-${ZSTD_LEVEL}" -o "$OUT/$track.tar.zst"
    sha256sum "$OUT/$track.tar.zst" | awk '{print $1}' > "$OUT/$track.tar.zst.sha256"
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
echo "Packed tracks:$packed"
