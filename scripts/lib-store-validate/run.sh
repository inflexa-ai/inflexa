#!/usr/bin/env bash
# Acceptance driver — run the validation suite
# (scripts/lib-store-validate/validate.py) against a library store the way a
# user's sandbox actually consumes it, in one of two modes:
#
#   --image <ref>   Boot a published sandbox image directly (the OSS path). The
#                   store is baked at /mnt/libs/current and the resolver env is
#                   baked into the image, so nothing is mounted or injected.
#   --store <path>  Mount a store dir read-only at /mnt/libs in sandbox-base (the
#                   managed path — mounted tarballs) and inject the resolver env.
#
# The suite runs import-all (advertised ⊆ loadable) plus the per-library
# smoke-test suite (scripts/lib-validator/run_all.py, mounted at /opt/lib-validator).
# It is NON-GATING: it validates and reports, promoting nothing.
#
# Usage:
#   scripts/lib-store-validate/run.sh [--no-validators] [--summary-md <file>] \
#       (--image <ref> | --store <path>)
#
#   (default)         import-all + per-library validators
#   --no-validators   import-all only (quick core check)
#   --summary-md F    write the markdown results table to host file F (rendered
#                     into the CI step summary by lib-store-acceptance.sh)
#   --image REF       boot this baked image (no mount)
#   --store PATH      store dir to mount (default: $INFLEXA_LIB_STORE or
#                     $XDG_DATA_HOME/inflexa/libs)
#
# The suite reads /mnt/libs/current/packages.txt and validates exactly what it
# advertises — no hardcoded package list. Exits non-zero (fail loud) on any
# failure so a maintainer sees a red status.

set -euo pipefail

SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR_DIR="$(cd "$SUITE_DIR/../lib-validator" && pwd)"
LIB_PATH="${INFLEXA_LIB_STORE:-${XDG_DATA_HOME:-${HOME:-/root}/.local/share}/inflexa/libs}"
MOUNT_IMAGE="${SANDBOX_BASE_IMAGE:-sandbox-base:latest}"
BAKED_IMAGE=""
SUMMARY_MD=""
SUITE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-validators) SUITE_ARGS+=("--no-validators"); shift ;;
    --summary-md)    SUMMARY_MD="$2"; shift 2 ;;
    --image)         BAKED_IMAGE="$2"; shift 2 ;;
    --store)         LIB_PATH="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Optional: write the markdown results table out to a host file. Mount its dir
# writable at /out and point validate.py at it via LIB_STORE_SUMMARY_MD; the
# array stays empty (a no-op in the docker run) when --summary-md is unset.
SUMMARY_ARGS=()
if [ -n "$SUMMARY_MD" ]; then
  mkdir -p "$(dirname "$SUMMARY_MD")"
  SUMMARY_DIR="$(cd "$(dirname "$SUMMARY_MD")" && pwd)"
  # The container runs as the unprivileged sandbox user (uid 1000), so the bind
  # target must be group/other-writable or validate.py can't drop the table into it.
  chmod 0777 "$SUMMARY_DIR" 2>/dev/null || true
  SUMMARY_ARGS=( -v "$SUMMARY_DIR:/out" -e LIB_STORE_SUMMARY_MD="/out/$(basename "$SUMMARY_MD")" )
fi

if [ -n "$BAKED_IMAGE" ]; then
  # OSS path: the store is baked into the image and the resolver env is baked in
  # too, so mount only the suite + the per-library validators + a writable
  # /mnt/refs stub (celltypist and friends probe $CELLTYPIST_FOLDER=/mnt/refs/...
  # at import time).
  #
  # --entrypoint "" because sandbox images inherit sandbox-base's ENTRYPOINT,
  # which boots sandbox-server and exits non-zero without SANDBOX_CALLBACK_SECRET.
  # Without the override the probe dies before validate.py is ever reached.
  echo "Validating baked store inside $BAKED_IMAGE ..."
  docker run --rm --entrypoint "" \
    -v "$SUITE_DIR:/opt/lib-store-validate:ro" \
    -v "$VALIDATOR_DIR:/opt/lib-validator:ro" \
    --tmpfs /mnt/refs \
    -e LIB_VALIDATOR_DIR=/opt/lib-validator \
    -e LIB_STORE_VERSION="${LIB_STORE_VERSION:-}" \
    "${SUMMARY_ARGS[@]}" \
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
#
# The /mnt/libs/current/... paths below are CONTAINER-INTERNAL: they name where
# the store lives inside the image, independent of any host INFLEXA_LIB_ROOT, so
# they are hardcoded rather than sourced from lib-store-common.sh's LIB_STORE_ROOT.
#
# --entrypoint "" for the same reason as the baked path above: MOUNT_IMAGE is
# sandbox-base, which defines the ENTRYPOINT the sandbox images inherit.
docker run --rm --entrypoint "" \
  -v "$LIB_PATH:/mnt/libs:ro" \
  -v "$SUITE_DIR:/opt/lib-store-validate:ro" \
  -v "$VALIDATOR_DIR:/opt/lib-validator:ro" \
  --tmpfs /mnt/refs \
  -e R_LIBS_SITE="/mnt/libs/current/r/github:/mnt/libs/current/r/bioconductor:/mnt/libs/current/r/cran" \
  -e NODE_PATH="/mnt/libs/current/node/node_modules" \
  -e PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/mnt/libs/current/conda/bin" \
  -e LIB_VALIDATOR_DIR=/opt/lib-validator \
  -e LIB_STORE_VERSION="${LIB_STORE_VERSION:-}" \
  "${SUMMARY_ARGS[@]}" \
  "$MOUNT_IMAGE" \
  python3 /opt/lib-store-validate/validate.py "${SUITE_ARGS[@]}"
