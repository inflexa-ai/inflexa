#!/usr/bin/env bash
# Gate 2 driver — mount a library store read-only into sandbox-base (the way a
# user's sandbox runs: read-only, no network, runtime env only) and run the
# derived validation suite (scripts/lib-store-validate/validate.py).
#
# Usage:
#   scripts/lib-store-validate/run.sh [--full] [--r-examples] [--no-anchors] [--store PATH]
#
#   (default)      import-all + anchors + invariant (the fast dev/Gate-2 core)
#   --r-examples   also run each R package's own examples (heavy)
#   --full         --r-examples plus anchors (the full Gate 2 pass)
#   --no-anchors   import-all + invariant only
#   --store PATH   store dir to mount (default: $INFLEXA_LIB_STORE or
#                  $XDG_DATA_HOME/inflexa/libs)
#
# The suite reads the mounted /mnt/libs/current/packages.txt and validates
# exactly what it advertises — no hardcoded package list. Exits non-zero (fail
# loud) on any failure so CI can gate promotion on it.

set -euo pipefail

SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_PATH="${INFLEXA_LIB_STORE:-${XDG_DATA_HOME:-$HOME/.local/share}/inflexa/libs}"
IMAGE="${SANDBOX_BASE_IMAGE:-sandbox-base:latest}"
SUITE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --full)        SUITE_ARGS+=("--r-examples"); shift ;;
    --r-examples)  SUITE_ARGS+=("--r-examples"); shift ;;
    --no-anchors)  SUITE_ARGS+=("--no-anchors"); shift ;;
    --store)       LIB_PATH="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ ! -d "$LIB_PATH/current" ]; then
  echo "Error: library store not found at $LIB_PATH/current" >&2
  echo "Build one with scripts/build-libs-local.sh, or pass --store PATH." >&2
  exit 1
fi

echo "Validating store at $LIB_PATH/current in $IMAGE ..."

# Mirror the runtime mount contract (harness lib-store spec): read-only mount,
# R_LIBS_SITE / NODE_PATH / conda-bin PATH injected, PYTHONPATH ABSENT (system
# Python resolves the store via sandbox-base's .pth file). A subset of R
# subtrees present is harmless — nonexistent libpaths are ignored.
#
# A writable /mnt/refs stub stands in for the ref-store mount the runtime always
# provides: some packages probe $CELLTYPIST_FOLDER=/mnt/refs/... at IMPORT
# (celltypist mkdir(exist_ok=True)), so without the mountpoint import-all false-fails
# on a ref-store dependency that has nothing to do with lib-store loadability.
docker run --rm \
  -v "$LIB_PATH:/mnt/libs:ro" \
  -v "$SUITE_DIR:/opt/lib-store-validate:ro" \
  --tmpfs /mnt/refs \
  -e R_LIBS_SITE="/mnt/libs/current/r/github:/mnt/libs/current/r/bioconductor:/mnt/libs/current/r/cran" \
  -e NODE_PATH="/mnt/libs/current/node/node_modules" \
  -e PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/mnt/libs/current/conda/bin" \
  -e LIB_STORE_R_EXAMPLE_LIMIT="${LIB_STORE_R_EXAMPLE_LIMIT:-}" \
  -e LIB_STORE_R_EXAMPLE_TIMEOUT="${LIB_STORE_R_EXAMPLE_TIMEOUT:-120}" \
  "$IMAGE" \
  python3 /opt/lib-store-validate/validate.py "${SUITE_ARGS[@]}"
