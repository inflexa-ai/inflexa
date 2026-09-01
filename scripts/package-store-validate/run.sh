#!/usr/bin/env bash
# Acceptance driver — run the validation suite
# (scripts/package-store-validate/validate.py) against a package store the way a
# user's sandbox actually consumes it: the store dir mounts read-only at
# /mnt/libs in sandbox-base, the catalog farm binds at /mnt/libs/farm, and the
# resolver env is injected. The image bakes NO package — a store mount is the
# one mode, and there is no baked-image path.
#
# The suite runs import-all (advertised ⊆ loadable) plus the per-library
# smoke-test suite (scripts/lib-validator/run_all.py, mounted at /opt/lib-validator).
# It is NON-GATING: it validates and reports, promoting nothing.
#
# Usage:
#   scripts/package-store-validate/run.sh [--no-validators] [--summary-md <file>] \
#       [--store <path>]
#
#   (default)         import-all + per-library validators
#   --no-validators   import-all only (quick core check)
#   --summary-md F    write the markdown results table to host file F (rendered
#                     into the CI step summary by package-store-acceptance.sh)
#   --store PATH      store dir to mount (default: $INFLEXA_LIB_STORE or
#                     $XDG_DATA_HOME/inflexa/libs)
#
# The suite reads the farm inflexa.lock and the baked image fragment, and validates exactly what they
# advertises — no hardcoded package list. Exits non-zero (fail loud) on any
# failure so a maintainer sees a red status.

set -euo pipefail

SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR_DIR="$(cd "$SUITE_DIR/../lib-validator" && pwd)"
LIB_PATH="${INFLEXA_LIB_STORE:-${XDG_DATA_HOME:-${HOME:-/root}/.local/share}/inflexa/libs}"
MOUNT_IMAGE="${SANDBOX_BASE_IMAGE:-sandbox-base:latest}"
SUMMARY_MD=""
# The suite validates a farm-backed store — that is the ONE mode — thus the
# farm-store rule of validate.py is always on: each advertised Python module
# must resolve from the content store, not from a shadow tree.
SUITE_ARGS=("--farm")  # expanded with the ${arr[@]+...} guard: bash 3.2 (macOS) errors on an empty array under set -u

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-validators) SUITE_ARGS+=("--no-validators"); shift ;;
    --summary-md)    SUMMARY_MD="$2"; shift 2 ;;
    --store)         LIB_PATH="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Optional: write the markdown results table out to a host file. Mount its dir
# writable at /out and point validate.py at it via PACKAGE_STORE_SUMMARY_MD; the
# array stays empty (a no-op in the docker run) when --summary-md is unset.
SUMMARY_ARGS=()
if [ -n "$SUMMARY_MD" ]; then
  mkdir -p "$(dirname "$SUMMARY_MD")"
  SUMMARY_DIR="$(cd "$(dirname "$SUMMARY_MD")" && pwd)"
  # The container runs as the unprivileged sandbox user (uid 1000), so the bind
  # target must be group/other-writable or validate.py can't drop the table into it.
  chmod 0777 "$SUMMARY_DIR" 2>/dev/null || true
  SUMMARY_ARGS=( -v "$SUMMARY_DIR:/out" -e PACKAGE_STORE_SUMMARY_MD="/out/$(basename "$SUMMARY_MD")" )
fi

# The store carries no active-farm pointer. A farm is a property of the sandbox,
# thus the invoker names the farm and binds it at the container path. The catalog
# farm is what a published store brings, and it is what a consumer of the artifact
# validates.
FARM_NAME="${FARM_NAME:-catalog}"
FARM_PATH="$LIB_PATH/farms/$FARM_NAME"

if [ ! -d "$FARM_PATH" ]; then
  echo "Error: no farm at $FARM_PATH" >&2
  echo "Pass --store PATH at a store root that holds farms/$FARM_NAME." >&2
  exit 1
fi

echo "Validating farm $FARM_NAME of the store at $LIB_PATH in $MOUNT_IMAGE ..."

# Managed path: mirror the runtime mount contract (harness package-store spec):
# read-only mount, R_LIBS_SITE / NODE_PATH / conda-bin PATH injected, PYTHONPATH
# ABSENT (system Python resolves the store via sandbox-base's .pth file). A subset
# of R subtrees present is harmless — nonexistent libpaths are ignored.
#
# A writable /mnt/refs stub stands in for the ref-store mount the runtime always
# provides: some packages probe $CELLTYPIST_FOLDER=/mnt/refs/... at IMPORT
# (celltypist mkdir(exist_ok=True)), so without the mountpoint import-all
# false-fails on a ref-store dependency unrelated to store loadability.
#
# The /mnt/libs/farm/... paths below are CONTAINER-INTERNAL: they name where
# the store lives inside the image, independent of any host INFLEXA_LIB_ROOT, so
# they are hardcoded rather than sourced from a host variable.
#
# PATH and NODE_PATH name a path in the IMAGE, never a path under /mnt/libs. The
# image owns the conda track at /opt/conda and the Node track at /opt/node, and the
# store mounts over /mnt/libs. A store-relative value here would remove the
# command-line tools of the image, which is the same trap the harness mount plan
# documents.
#
# --entrypoint "" for the same reason as the baked path above: MOUNT_IMAGE is
# sandbox-base, which defines its own ENTRYPOINT.
# The farm bind nests inside the store bind, thus it comes AFTER it. The farm
# shadows its mount point inside the store, and each farm link into
# /mnt/libs/store resolves through the store bind.
#
# runc cannot make the farm mountpoint inside a read-only mount, thus a docker
# engine refuses the nested bind when the store copy has no `farm/` entry. crun
# (podman) makes the mountpoint itself, and the mkdir is then a no-op. The
# mountpoint is host-side state of the invoker's store COPY, never part of the
# packed artifact — the build removes it from the volume before the pack.
mkdir -p "$LIB_PATH/farm"
# The posture of a real sandbox, because a green run here must predict a green
# import there: no network (an import that dials out passes an open run and
# fails a real step), no capability, and no privilege escalation. The image
# already runs as the unprivileged sandbox user.
docker run --rm --entrypoint "" \
  --network none --cap-drop ALL --security-opt no-new-privileges \
  -v "$LIB_PATH:/mnt/libs:ro" \
  -v "$FARM_PATH:/mnt/libs/farm:ro" \
  -v "$SUITE_DIR:/opt/package-store-validate:ro" \
  -v "$VALIDATOR_DIR:/opt/lib-validator:ro" \
  --tmpfs /mnt/refs \
  -e R_LIBS_SITE="/mnt/libs/farm/r/github:/mnt/libs/farm/r/bioconductor:/mnt/libs/farm/r/cran" \
  -e NODE_PATH="/opt/node/node_modules" \
  -e PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/conda/bin:/mnt/libs/farm/python/bin" \
  -e LIB_VALIDATOR_DIR=/opt/lib-validator \
  -e PACKAGE_STORE_VERSION="${PACKAGE_STORE_VERSION:-}" \
  ${SUMMARY_ARGS[@]+"${SUMMARY_ARGS[@]}"} \
  "$MOUNT_IMAGE" \
  python3 /opt/package-store-validate/validate.py ${SUITE_ARGS[@]+"${SUITE_ARGS[@]}"}
