#!/usr/bin/env bash
# Assemble a bundle (or an explicit track set) from per-track tarballs into a
# mountable `current/` store: extract the selected tarballs and concatenate
# their packages.txt fragments — in canonical order — into a single
# packages.txt (the file the harness list_available_packages tool reads).
#
# This is the local/offline counterpart of `inflexa libs pull`: the same
# extract-then-concat step, below the harness runtime contract. The client pull
# handler (cli subsystem) does the equivalent after downloading tarballs by
# digest.
#
# Usage:
#   lib-store-assemble.sh --bundle <python-conda|python-r-conda> <dist_dir> <current_dir>
#   lib-store-assemble.sh --tracks "<t1 t2 ...>"                   <dist_dir> <current_dir>

set -euo pipefail

# shellcheck source=scripts/lib-store-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-store-common.sh"

MODE="${1:-}"; SEL="${2:-}"; DIST="${3:-}"; CURRENT="${4:-}"
if [ -z "$MODE" ] || [ -z "$SEL" ] || [ -z "$DIST" ] || [ -z "$CURRENT" ]; then
  echo "usage: lib-store-assemble.sh --bundle <name>|--tracks \"<t...>\" <dist_dir> <current_dir>" >&2
  exit 2
fi

case "$MODE" in
  --bundle) tracks="$(lib_store_bundle_tracks "$SEL")" || { echo "ERROR: unknown bundle: $SEL" >&2; exit 1; } ;;
  --tracks) tracks="$SEL" ;;
  *) echo "ERROR: first arg must be --bundle or --tracks" >&2; exit 2 ;;
esac

mkdir -p "$CURRENT"

for track in $tracks; do
  tb="$DIST/$track.tar.zst"
  [ -f "$tb" ] || { echo "ERROR: missing track tarball for '$track': $tb" >&2; exit 1; }
  zstd -dq -c "$tb" | tar -xf - -C "$CURRENT"
  echo "extracted $track"
done

# Concatenate the pulled tracks' fragments into the single packages.txt.
{
  lib_store_packages_header
  echo
  for track in $LIB_STORE_CONCAT_ORDER; do
    lib_store_list_has "$tracks" "$track" || continue
    frag="$CURRENT/$(lib_store_track_fragment "$track")"
    if [ -f "$frag" ]; then
      cat "$frag"
      echo
    fi
  done
} > "$CURRENT/packages.txt"

echo "Assembled [$tracks] into $CURRENT ($(wc -l < "$CURRENT/packages.txt") lines in packages.txt)"
