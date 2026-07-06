#!/usr/bin/env bash
# Acceptance driver — run the derived validation suite
# (scripts/lib-store-validate/validate.py) against a library store the way a
# user's sandbox actually consumes it, in one of two modes:
#
#   --image <ref>   Boot a published sandbox image directly (the OSS path). The
#                   store is baked at /mnt/libs/current and the resolver env is
#                   baked into the image, so nothing is mounted or injected.
#   --store <path>  Mount a store dir read-only at /mnt/libs in sandbox-base (the
#                   managed path — mounted tarballs) and inject the resolver env.
#
# Usage:
#   scripts/lib-store-validate/run.sh [--full] [--r-examples] [--no-anchors] \
#       (--image <ref> | --store <path>)
#
#   (default)      import-all + anchors + invariant (the fast core)
#   --r-examples   also run each R package's own examples (heavy)
#   --full         --r-examples plus anchors (the full acceptance pass)
#   --no-anchors   import-all + invariant only
#   --image REF    boot this baked image (no mount); default when neither is given
#                  is the --store path below
#   --store PATH   store dir to mount (default: $INFLEXA_LIB_STORE or
#                  $XDG_DATA_HOME/inflexa/libs)
#
# The suite reads /mnt/libs/current/packages.txt and validates exactly what it
# advertises — no hardcoded package list. Exits non-zero (fail loud) on any
# failure so CI can gate promotion on it.

set -euo pipefail

SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_PATH="${INFLEXA_LIB_STORE:-${XDG_DATA_HOME:-$HOME/.local/share}/inflexa/libs}"
MOUNT_IMAGE="${SANDBOX_BASE_IMAGE:-sandbox-base:latest}"
BAKED_IMAGE=""
SUITE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --full)        SUITE_ARGS+=("--r-examples"); shift ;;
    --r-examples)  SUITE_ARGS+=("--r-examples"); shift ;;
    --no-anchors)  SUITE_ARGS+=("--no-anchors"); shift ;;
    --image)       BAKED_IMAGE="$2"; shift 2 ;;
    --store)       LIB_PATH="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -n "$BAKED_IMAGE" ]; then
  # OSS path: the store is baked into the image and the resolver env is baked in
  # too, so mount only the suite + a writable /mnt/refs stub (celltypist and
  # friends probe $CELLTYPIST_FOLDER=/mnt/refs/... at import time).
  echo "Validating baked store inside $BAKED_IMAGE ..."
  docker run --rm \
    -v "$SUITE_DIR:/opt/lib-store-validate:ro" \
    --tmpfs /mnt/refs \
    -e LIB_STORE_R_EXAMPLE_LIMIT="${LIB_STORE_R_EXAMPLE_LIMIT:-}" \
    -e LIB_STORE_R_EXAMPLE_TIMEOUT="${LIB_STORE_R_EXAMPLE_TIMEOUT:-120}" \
    "$BAKED_IMAGE" \
    python3 /opt/lib-store-validate/validate.py "${SUITE_ARGS[@]}"
  exit $?
fi

if [ ! -d "$LIB_PATH/current" ]; then
  echo "Error: library store not found at $LIB_PATH/current" >&2
  echo "Pass --image <ref> to validate a baked image, or --store PATH for a mounted store." >&2
  exit 1
fi

echo "Validating store at $LIB_PATH/current in $MOUNT_IMAGE ..."

# Managed path: mirror the runtime mount contract (harness lib-store spec):
# read-only mount, R_LIBS_SITE / NODE_PATH / conda-bin PATH injected, PYTHONPATH
# ABSENT (system Python resolves the store via sandbox-base's .pth file). A subset
# of R subtrees present is harmless — nonexistent libpaths are ignored.
#
# A writable /mnt/refs stub stands in for the ref-store mount the runtime always
# provides: some packages probe $CELLTYPIST_FOLDER=/mnt/refs/... at IMPORT
# (celltypist mkdir(exist_ok=True)), so without the mountpoint import-all
# false-fails on a ref-store dependency unrelated to lib-store loadability.
docker run --rm \
  -v "$LIB_PATH:/mnt/libs:ro" \
  -v "$SUITE_DIR:/opt/lib-store-validate:ro" \
  --tmpfs /mnt/refs \
  -e R_LIBS_SITE="/mnt/libs/current/r/github:/mnt/libs/current/r/bioconductor:/mnt/libs/current/r/cran" \
  -e NODE_PATH="/mnt/libs/current/node/node_modules" \
  -e PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/mnt/libs/current/conda/bin" \
  -e LIB_STORE_R_EXAMPLE_LIMIT="${LIB_STORE_R_EXAMPLE_LIMIT:-}" \
  -e LIB_STORE_R_EXAMPLE_TIMEOUT="${LIB_STORE_R_EXAMPLE_TIMEOUT:-120}" \
  "$MOUNT_IMAGE" \
  python3 /opt/lib-store-validate/validate.py "${SUITE_ARGS[@]}"
