#!/usr/bin/env bash
# Emit the assembled packages.txt to stdout: the advisory header, then each
# packed track's fragment in the canonical concat order. This is the file the
# harness `list_available_packages` tool reads at /mnt/libs/current/packages.txt.
#
# No track tarball carries it — a fragment is per-track, the assembled file spans
# tracks — so the producer publishes it as its own object and a puller downloads
# it. The canonical order lives in lib-store-common.sh, which is why the assembly
# lives here and not in a consumer.
#
# Usage: lib-store-write-packages.sh <staging_dir> "<t1 t2 ...>"

set -euo pipefail

STAGING="${1:?usage: lib-store-write-packages.sh <staging_dir> \"<t1 t2 ...>\"}"
TRACKS="${2:?usage: lib-store-write-packages.sh <staging_dir> \"<t1 t2 ...>\"}"

# shellcheck source=scripts/lib-store-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-store-common.sh"

lib_store_packages_header
echo
for track in $LIB_STORE_CONCAT_ORDER; do
  lib_store_list_has "$TRACKS" "$track" || continue
  frag="$STAGING/$(lib_store_track_fragment "$track")"
  [ -f "$frag" ] || { echo "ERROR: track '$track' has no packages.txt fragment: $frag" >&2; exit 1; }
  cat "$frag"
  echo
done
